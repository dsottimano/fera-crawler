import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import {
  createState,
  spawnCrawl,
  stopCrawl,
  resumeCrawl,
  clearCrawl,
  filterResults,
  applyProbedConfig,
  type CrawlOpts,
} from "./crawler.js";
import { listSessions, loadSessionResults } from "./database.js";
import {
  domainOf,
  getConfigForUrl,
  listConfigs,
  probeAndCache,
  deleteCachedConfig,
} from "./configCache.js";
import { SIDECAR_DIR, SIDECAR_ENTRY } from "./paths.js";
import type { CrawlResult } from "./types.js";

const state = createState();

const server = new McpServer({
  name: "fera-crawler",
  version: "0.2.0",
});

// Full knob set — per durable guidance, never ship a partial surface.
const knobSchema = {
  headed: z.boolean().optional().describe("Show browser window (default false)"),
  userAgent: z.string().optional().describe("Custom User-Agent override"),
  customHeaders: z.record(z.string(), z.string()).optional().describe("Extra HTTP headers"),
  stealthConfig: z.record(z.string(), z.boolean()).optional().describe(
    "Stealth patches. Shape: { enabled: bool, webdriver: bool, plugins: bool, ... }. Set { enabled: true } for full default stack; { enabled: false } disables all patches.",
  ),
  sessionWarmup: z.boolean().optional().describe("Visit origin '/' first so challenge cookies (_abck, __cf_bm) establish before deep-linking"),
  browserProfile: z.string().optional().describe("Absolute path to browser profile directory"),
  concurrency: z.number().optional().describe("Global parallel tabs (default 5)"),
  delay: z.number().optional().describe("Global ms between request starts"),
  perHostDelay: z.number().optional().describe("Min ms between requests to same host (default 500)"),
  perHostConcurrency: z.number().optional().describe("Max concurrent requests per host (default 2)"),
  maxRequests: z.number().optional().describe("Cap on URLs crawled (0 = unlimited)"),
  downloadOgImage: z.boolean().optional().describe("Download og:image files"),
  captureVitals: z.boolean().optional().describe("Capture Core Web Vitals"),
  respectRobots: z.boolean().optional().describe("Honor robots.txt"),
  scraperRules: z.array(z.object({ name: z.string(), selector: z.string() })).optional().describe("Custom CSS extraction rules"),
  skipProbe: z.boolean().optional().describe("Skip the automatic probe-and-cache-config step that runs before the first crawl of a new domain"),
};

async function ensureConfigForUrl(url: string, skipProbe: boolean | undefined): Promise<{
  probed: Record<string, unknown> | null;
  probedNow: boolean;
  winningLabel: string | null;
}> {
  const cached = getConfigForUrl(url);
  if (cached) {
    return { probed: cached.config, probedNow: false, winningLabel: cached.winningLabel };
  }
  if (skipProbe) return { probed: null, probedNow: false, winningLabel: null };
  try {
    const probeResult = await probeAndCache(url);
    return { probed: probeResult.winningConfig, probedNow: true, winningLabel: probeResult.winningLabel };
  } catch {
    return { probed: null, probedNow: false, winningLabel: null };
  }
}

// ── crawl_url: blocking, single URL ──

server.tool(
  "crawl_url",
  "Crawl a single URL and return full SEO data. Auto-probes for the optimal stealth config on first visit to a domain; skip with skipProbe: true.",
  {
    url: z.string().describe("URL to crawl"),
    ...knobSchema,
  },
  async (opts) => {
    const { skipProbe, ...rest } = opts;
    const { probed, probedNow, winningLabel } = await ensureConfigForUrl(opts.url, skipProbe);

    const crawlOpts: CrawlOpts = applyProbedConfig(
      { mode: "list", urls: [opts.url], ...rest } as CrawlOpts,
      probed,
    );
    const args = [
      "crawl", opts.url,
      "--mode", "list",
      "--urls", opts.url,
      "--max-requests", "1",
      ...(crawlOpts.headed || crawlOpts.headless === false ? ["--headless", "false"] : []),
      ...(crawlOpts.userAgent ? ["--user-agent", crawlOpts.userAgent] : []),
      ...(crawlOpts.downloadOgImage ? ["--download-og-image"] : []),
      ...(crawlOpts.captureVitals ? ["--capture-vitals"] : []),
      ...(crawlOpts.sessionWarmup ? ["--session-warmup"] : []),
      ...(crawlOpts.respectRobots ? ["--respect-robots"] : []),
      ...(crawlOpts.browserProfile ? ["--browser-profile", crawlOpts.browserProfile] : []),
      ...(crawlOpts.perHostDelay !== undefined ? ["--per-host-delay", String(crawlOpts.perHostDelay)] : []),
      ...(crawlOpts.perHostConcurrency !== undefined ? ["--per-host-concurrency", String(crawlOpts.perHostConcurrency)] : []),
      ...(crawlOpts.stealthConfig ? ["--stealth-config", JSON.stringify(crawlOpts.stealthConfig)] : []),
      ...(crawlOpts.customHeaders && Object.keys(crawlOpts.customHeaders).length
          ? ["--custom-headers", JSON.stringify(crawlOpts.customHeaders)] : []),
    ];

    return new Promise((resolve) => {
      const proc = spawn("npx", ["tsx", SIDECAR_ENTRY, ...args], {
        cwd: SIDECAR_DIR,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      proc.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr!.on("data", () => {});

      proc.on("close", () => {
        const lines = stdout.trim().split("\n");
        for (const line of lines) {
          try {
            const result: CrawlResult = JSON.parse(line);
            const payload = {
              ...result,
              _configApplied: winningLabel ? { label: winningLabel, probedNow } : { label: null, probedNow: false },
            };
            resolve({ content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] });
            return;
          } catch {}
        }
        resolve({ content: [{ type: "text" as const, text: "No result returned." }] });
      });
    });
  }
);

// ── crawl_site: spider ──

server.tool(
  "crawl_site",
  "Start spidering a domain. Non-blocking — use get_crawl_status / get_crawl_data to check progress. Auto-probes for optimal stealth config first.",
  {
    url: z.string().describe("Start URL"),
    ...knobSchema,
  },
  async (opts) => {
    try {
      const { skipProbe, ...rest } = opts;
      const { probed, probedNow, winningLabel } = await ensureConfigForUrl(opts.url, skipProbe);
      clearCrawl(state);
      const full = applyProbedConfig({ ...rest, url: opts.url, mode: "spider" } as CrawlOpts, probed);
      spawnCrawl(state, full);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          status: state.status,
          url: state.startUrl,
          configApplied: winningLabel ? { label: winningLabel, probedNow } : { label: null, probedNow: false },
          message: "Crawl started. Use get_crawl_status or get_crawl_data to check progress.",
        }) }],
      };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
    }
  }
);

// ── crawl_list ──

server.tool(
  "crawl_list",
  "Crawl a specific list of URLs. Non-blocking. Auto-probes using the first URL's domain.",
  {
    urls: z.array(z.string()).describe("URLs to crawl"),
    ...knobSchema,
  },
  async (opts) => {
    try {
      if (!opts.urls?.length) {
        return { content: [{ type: "text" as const, text: "Error: urls array is empty." }] };
      }
      const { skipProbe, ...rest } = opts;
      const { probed, probedNow, winningLabel } = await ensureConfigForUrl(opts.urls[0], skipProbe);
      clearCrawl(state);
      const full = applyProbedConfig(
        { ...rest, url: opts.urls[0], mode: "list", urls: opts.urls } as CrawlOpts,
        probed,
      );
      spawnCrawl(state, full);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          status: state.status,
          urlCount: opts.urls.length,
          configApplied: winningLabel ? { label: winningLabel, probedNow } : { label: null, probedNow: false },
          message: "Crawl started. Use get_crawl_status or get_crawl_data to check progress.",
        }) }],
      };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
    }
  }
);

// ── probe_crawl_config ──

server.tool(
  "probe_crawl_config",
  "Probe a URL through the 5-rung stealth ladder, measure speed + content-quality, cache the winning config. Returns full attempt detail. Use this before a large crawl to pick the cheapest config that (1) returns 2xx, (2) delivers real content (not a WAF stub or challenge page), (3) isn't cloaked.",
  {
    url: z.string().describe("URL to probe"),
  },
  async ({ url }) => {
    try {
      const result = await probeAndCache(url);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          url: result.url,
          winningLabel: result.winningLabel,
          winningConfig: result.winningConfig,
          ranking: result.ranking,
          attempts: result.attempts,
          probedAt: result.probedAt,
        }, null, 2) }],
      };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Probe failed: ${e.message}` }] };
    }
  }
);

// ── get_crawl_config ──

server.tool(
  "get_crawl_config",
  "Look up the cached probe result for a domain. Returns null if not yet probed.",
  {
    url: z.string().describe("URL (or bare domain)"),
  },
  async ({ url }) => {
    const cached = getConfigForUrl(url);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(cached ?? { domain: domainOf(url), config: null }, null, 2) }],
    };
  }
);

// ── list_crawl_configs ──

server.tool(
  "list_crawl_configs",
  "List all cached per-domain crawl configs.",
  {},
  async () => {
    const all = listConfigs();
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ count: all.length, configs: all }, null, 2) }],
    };
  }
);

// ── delete_crawl_config ──

server.tool(
  "delete_crawl_config",
  "Delete the cached config for a domain. Next crawl of that domain will re-probe.",
  {
    domain: z.string().describe("Domain (e.g. 'example.com')"),
  },
  async ({ domain }) => {
    deleteCachedConfig(domain);
    return { content: [{ type: "text" as const, text: JSON.stringify({ deleted: domain }) }] };
  }
);

// ── stop_crawl / resume_crawl / get_crawl_status / get_crawl_data ──

server.tool(
  "stop_crawl",
  "Stop the active crawl. Can be resumed later with resume_crawl.",
  {},
  async () => {
    stopCrawl(state);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        status: state.status,
        urlsFound: state.results.length,
      }) }],
    };
  }
);

server.tool(
  "resume_crawl",
  "Resume a previously stopped crawl. Already-crawled URLs are deduped.",
  {},
  async () => {
    try {
      resumeCrawl(state);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          status: state.status,
          urlsFound: state.results.length,
          message: "Crawl resumed.",
        }) }],
      };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  "get_crawl_status",
  "Get the current crawl status and URL count.",
  {},
  async () => {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        status: state.status,
        urlsFound: state.results.length,
        url: state.startUrl || null,
        startedAt: state.startedAt,
      }) }],
    };
  }
);

server.tool(
  "get_crawl_data",
  "Get crawl results with optional filtering and field projection. Default limit 50.",
  {
    filter: z.object({
      statusCode: z.number().optional(),
      resourceType: z.string().optional(),
      isNoindex: z.boolean().optional(),
      hasOgImage: z.boolean().optional(),
      hasError: z.boolean().optional(),
    }).optional().describe("Filter results"),
    fields: z.array(z.string()).optional().describe("Return only these fields"),
    limit: z.number().optional().describe("Max results (default 50)"),
    offset: z.number().optional().describe("Skip first N"),
  },
  async ({ filter, fields, limit, offset }) => {
    const data = filterResults(state.results, filter, fields, limit ?? 50, offset ?? 0);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        total: state.results.length,
        returned: data.length,
        offset: offset ?? 0,
        results: data,
      }, null, 2) }],
    };
  }
);

// ── saved crawl sessions (unchanged) ──

server.tool(
  "get_saved_crawls",
  "List saved crawl sessions from the Fera database.",
  {},
  async () => {
    const sessions = listSessions();
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        count: sessions.length,
        sessions: sessions.map((s) => ({
          id: s.id, url: s.start_url, startedAt: s.started_at,
          completedAt: s.completed_at, resultCount: s.result_count,
        })),
      }, null, 2) }],
    };
  }
);

server.tool(
  "load_saved_crawl",
  "Load a saved crawl session into memory for querying with get_crawl_data.",
  { sessionId: z.number().describe("Session ID from get_saved_crawls") },
  async ({ sessionId }) => {
    clearCrawl(state);
    const results = loadSessionResults(sessionId);
    state.results = results;
    for (const r of results) state.visitedUrls.add(r.url);
    state.status = "stopped";
    state.startUrl = results[0]?.url ?? "";
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        loaded: true, sessionId, urlsFound: results.length,
      }) }],
    };
  }
);

// ── browser open/close (unchanged) ──

server.tool(
  "open_browser",
  "Open a headed browser for sign-in. Uses persistent profile shared with crawler.",
  { url: z.string().describe("URL to navigate to") },
  async ({ url }) => {
    if (state.browserProcess) {
      state.browserProcess.kill();
      state.browserProcess = null;
    }
    const proc = spawn("npx", ["tsx", SIDECAR_ENTRY, "open-browser", url], {
      cwd: SIDECAR_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    state.browserProcess = proc;
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        status: "open", url, message: "Browser opened. Call close_browser when done.",
      }) }],
    };
  }
);

server.tool(
  "close_browser",
  "Close the sign-in browser.",
  {},
  async () => {
    if (state.browserProcess) {
      state.browserProcess.kill();
      state.browserProcess = null;
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ status: "closed" }) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
