import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { SIDECAR_DIR, SIDECAR_ENTRY, OG_IMAGES_DIR } from "./paths.js";
import type { CrawlResult, ServerState } from "./types.js";

export function createState(): ServerState {
  return {
    crawlProcess: null,
    browserProcess: null,
    results: [],
    visitedUrls: new Set(),
    status: "idle",
    startUrl: "",
    config: {},
    startedAt: null,
  };
}

export interface CrawlOpts {
  url: string;
  mode: "spider" | "list";
  urls?: string[];
  urlsFile?: string;
  // Browser/stealth
  headed?: boolean;
  headless?: boolean;
  userAgent?: string;
  customHeaders?: Record<string, string>;
  stealthConfig?: Record<string, boolean>;
  sessionWarmup?: boolean;
  browserProfile?: string;
  // Rate limits / throughput
  concurrency?: number;
  delay?: number;
  perHostDelay?: number;
  perHostConcurrency?: number;
  maxRequests?: number;
  // Extraction
  downloadOgImage?: boolean;
  captureVitals?: boolean;
  respectRobots?: boolean;
  scraperRules?: Array<{ name: string; selector: string }>;
}

export function buildArgs(opts: CrawlOpts): string[] {
  const args = [
    "crawl", opts.url,
    "--mode", opts.mode,
    "--concurrency", String(opts.concurrency ?? 5),
    "--max-requests", String(opts.maxRequests ?? 0),
  ];

  // headed/headless: accept either. `headless === false` or `headed === true`
  // both mean "show a window"; default is headless.
  if (opts.headed === true || opts.headless === false) {
    args.push("--headless", "false");
  }
  if (opts.userAgent) args.push("--user-agent", opts.userAgent);
  if (opts.delay && opts.delay > 0) args.push("--delay", String(opts.delay));
  if (opts.respectRobots) args.push("--respect-robots");
  if (opts.captureVitals) args.push("--capture-vitals");
  if (opts.sessionWarmup) args.push("--session-warmup");
  if (opts.browserProfile) args.push("--browser-profile", opts.browserProfile);
  if (opts.perHostDelay !== undefined) args.push("--per-host-delay", String(opts.perHostDelay));
  if (opts.perHostConcurrency !== undefined) args.push("--per-host-concurrency", String(opts.perHostConcurrency));
  if (opts.stealthConfig && Object.keys(opts.stealthConfig).length) {
    args.push("--stealth-config", JSON.stringify(opts.stealthConfig));
  }
  if (opts.scraperRules && opts.scraperRules.length) {
    args.push("--scraper-rules", JSON.stringify(opts.scraperRules));
  }
  if (opts.customHeaders && Object.keys(opts.customHeaders).length) {
    args.push("--custom-headers", JSON.stringify(opts.customHeaders));
  }
  if (opts.mode === "list" && opts.urlsFile) {
    args.push("--urls-file", opts.urlsFile);
  } else if (opts.mode === "list" && opts.urls?.length) {
    args.push("--urls", opts.urls.join(","));
  }
  if (opts.downloadOgImage) args.push("--download-og-image");
  return args;
}

function resolveOgImagePath(result: CrawlResult): CrawlResult {
  if (!result.ogImage) return result;
  try {
    const parsedPage = new URL(result.url);
    const domainDir = path.join(OG_IMAGES_DIR, parsedPage.hostname);
    if (fs.existsSync(domainDir)) {
      // Find the image file that matches (uses the hash-based naming)
      const files = fs.readdirSync(domainDir);
      const hash = crypto.createHash("md5").update(result.ogImage).digest("hex").slice(0, 8);
      const match = files.find((f: string) => f.includes(hash));
      if (match) {
        result.ogImagePath = path.join(domainDir, match);
      }
    }
  } catch {}
  return result;
}

export function spawnCrawl(state: ServerState, opts: CrawlOpts): void {
  if (state.status === "crawling") {
    throw new Error("A crawl is already running. Stop it first.");
  }

  state.startUrl = opts.url;
  state.config = { ...opts };
  state.status = "crawling";
  state.startedAt = new Date().toISOString();

  // Don't clear results/visitedUrls if resuming (caller handles that)
  const args = buildArgs(opts);

  const proc = spawn("npx", ["tsx", SIDECAR_ENTRY, ...args], {
    cwd: SIDECAR_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });

  state.crawlProcess = proc;

  let buffer = "";
  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const result: CrawlResult = JSON.parse(line);
        // Deduplicate (for resume)
        if (state.visitedUrls.has(result.url)) continue;
        state.visitedUrls.add(result.url);
        resolveOgImagePath(result);
        state.results.push(result);
      } catch {}
    }
  });

  proc.stderr!.on("data", () => {});

  proc.on("close", () => {
    if (state.status === "crawling") {
      state.status = "stopped";
    }
    state.crawlProcess = null;
  });
}

export function stopCrawl(state: ServerState): void {
  if (state.crawlProcess) {
    state.crawlProcess.kill();
    state.crawlProcess = null;
  }
  if (state.status === "crawling") {
    state.status = "stopped";
  }
}

export function resumeCrawl(state: ServerState): void {
  if (state.status !== "stopped" || !state.startUrl) {
    throw new Error("No stopped crawl to resume.");
  }
  // visitedUrls and results are already populated — spawnCrawl will deduplicate
  spawnCrawl(state, state.config as CrawlOpts);
}

/**
 * Apply a cached probe config to user-supplied opts. User-supplied values
 * always win — the probe result is a baseline, not an override.
 */
export function applyProbedConfig(
  opts: CrawlOpts,
  probed: Record<string, unknown> | null | undefined,
): CrawlOpts {
  if (!probed) return opts;
  const out: CrawlOpts = { ...opts };
  const merge = <K extends keyof CrawlOpts>(k: K, v: unknown) => {
    if (out[k] === undefined && v !== undefined) (out as any)[k] = v;
  };
  merge("stealthConfig", probed.stealthConfig as Record<string, boolean> | undefined);
  merge("headless", probed.headless);
  merge("sessionWarmup", probed.sessionWarmup);
  merge("perHostDelay", probed.perHostDelay);
  merge("perHostConcurrency", probed.perHostConcurrency);
  merge("concurrency", probed.concurrency);
  return out;
}

export function clearCrawl(state: ServerState): void {
  stopCrawl(state);
  state.results = [];
  state.visitedUrls.clear();
  state.status = "idle";
  state.startUrl = "";
  state.config = {};
  state.startedAt = null;
}

export interface FilterOpts {
  statusCode?: number;
  resourceType?: string;
  isNoindex?: boolean;
  hasOgImage?: boolean;
  hasError?: boolean;
}

export function filterResults(
  results: CrawlResult[],
  filter?: FilterOpts,
  fields?: string[],
  limit = 50,
  offset = 0,
): any[] {
  let filtered = results;

  if (filter) {
    if (filter.statusCode !== undefined) {
      filtered = filtered.filter((r) => r.status === filter.statusCode);
    }
    if (filter.resourceType !== undefined) {
      filtered = filtered.filter((r) => r.resourceType === filter.resourceType);
    }
    if (filter.isNoindex !== undefined) {
      filtered = filtered.filter((r) => r.isNoindex === filter.isNoindex);
    }
    if (filter.hasOgImage !== undefined) {
      filtered = filtered.filter((r) =>
        filter.hasOgImage ? !!r.ogImage : !r.ogImage
      );
    }
    if (filter.hasError !== undefined) {
      filtered = filtered.filter((r) =>
        filter.hasError ? !!r.error : !r.error
      );
    }
  }

  const paged = filtered.slice(offset, offset + limit);

  if (fields && fields.length > 0) {
    return paged.map((r) => {
      const projected: any = {};
      for (const f of fields) {
        if (f in r) projected[f] = (r as any)[f];
      }
      return projected;
    });
  }

  return paged;
}
