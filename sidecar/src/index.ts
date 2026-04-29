import fs from "node:fs";
import { runCrawler, openBrowser, dumpProfile } from "./crawler.js";
import { openInspector } from "./inspector.js";
import { runProbeMatrix } from "./probeMatrix.js";
import type { CrawlConfig } from "./types.js";
import { startMetricEmitter, stopMetricEmitter, log, setDebugEnabled } from "./observability.js";

const args = process.argv.slice(2);

function getFlag(name: string, defaultVal: string): string {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return defaultVal;
  return args[idx + 1];
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

const command = args[0];

if (command === "open-browser") {
  const url = args[1];
  if (!url) {
    console.error("Usage: fera-crawler open-browser <url> [--browser-profile PATH]");
    process.exit(1);
  }
  const browserProfile = getFlag("--browser-profile", "");
  openBrowser(url, browserProfile || undefined)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Browser error:", err);
      process.exit(1);
    });
} else if (command === "dump-profile") {
  const url = args[1];
  if (!url) {
    console.error("Usage: fera-crawler dump-profile <url> [--browser-profile PATH]");
    process.exit(1);
  }
  const browserProfile = getFlag("--browser-profile", "");
  dumpProfile(url, browserProfile || undefined)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Dump profile error:", err);
      process.exit(1);
    });
} else if (command === "inspect") {
  const url = args[1];
  if (!url) {
    console.error("Usage: fera-crawler inspect <url> [--browser-profile PATH]");
    process.exit(1);
  }
  const browserProfile = getFlag("--browser-profile", "");
  openInspector(url, browserProfile || undefined)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Inspector error:", err);
      process.exit(1);
    });
} else if (command === "probe-matrix") {
  const sampleUrl = args[1];
  if (!sampleUrl) {
    console.error("Usage: fera-crawler probe-matrix <sampleUrl> [--browser-profile PATH]");
    process.exit(1);
  }
  const browserProfile = getFlag("--browser-profile", "");
  runProbeMatrix(sampleUrl, browserProfile || undefined)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Probe matrix error:", err);
      process.exit(1);
    });
} else if (command === "crawl") {
  if (!args[1]) {
    console.error(
      "Usage: fera-crawler crawl <url> [--max-requests N] [--concurrency N] " +
      "[--user-agent UA] [--respect-robots] [--delay MS] " +
      "[--custom-headers JSON] [--mode spider|list] [--urls url1,url2,...] " +
      "[--browser-profile PATH]"
    );
    process.exit(1);
  }

  const url = args[1];
  const maxRequests = parseInt(getFlag("--max-requests", "0"), 10);
  const concurrency = parseInt(getFlag("--concurrency", "5"), 10);
  const userAgent = getFlag("--user-agent", "");
  const respectRobots = hasFlag("--respect-robots");
  const delay = parseInt(getFlag("--delay", "0"), 10);
  const customHeadersRaw = getFlag("--custom-headers", "");
  const mode = getFlag("--mode", "spider") as "spider" | "list";
  const urlsRaw = getFlag("--urls", "");
  const browserProfile = getFlag("--browser-profile", "");

  let customHeaders: Record<string, string> | undefined;
  if (customHeadersRaw) {
    try {
      customHeaders = JSON.parse(customHeadersRaw);
    } catch {
      console.error("Error: --custom-headers must be a valid JSON string");
      process.exit(1);
    }
  }

  // Support --urls-file for large URL lists (one URL per line, or CSV with URL in first column)
  const urlsFile = getFlag("--urls-file", "");
  let urls: string[] | undefined;
  if (urlsFile) {
    const content = fs.readFileSync(urlsFile, "utf8");
    urls = content.split("\n")
      .map((line) => line.split(",")[0].trim())
      .filter((u) => u && u.startsWith("http"));
  } else {
    urls = urlsRaw ? urlsRaw.split(",").map((u) => u.trim()) : undefined;
  }
  const headlessRaw = getFlag("--headless", "true");
  const headless = headlessRaw !== "false";
  const downloadOgImage = hasFlag("--download-og-image");
  const captureVitals = hasFlag("--capture-vitals");

  const scraperRulesRaw = getFlag("--scraper-rules", "");
  const scraperRulesFile = getFlag("--scraper-rules-file", "");
  let scraperRules: Array<{ name: string; selector: string }> | undefined;
  const scraperJson = scraperRulesFile ? fs.readFileSync(scraperRulesFile, "utf8") : scraperRulesRaw;
  if (scraperJson) {
    try {
      scraperRules = JSON.parse(scraperJson);
    } catch {
      console.error("Error: scraper rules must be valid JSON");
      process.exit(1);
    }
  }

  const perHostDelayRaw = getFlag("--per-host-delay", "");
  const perHostDelay = perHostDelayRaw ? parseInt(perHostDelayRaw, 10) : undefined;
  // --per-host-delay-max upper-bounds the random per-request delay range.
  // If unset (or <= min), jitter is disabled and behavior is fixed delayMin.
  const perHostDelayMaxRaw = getFlag("--per-host-delay-max", "");
  const perHostDelayMax = perHostDelayMaxRaw ? parseInt(perHostDelayMaxRaw, 10) : undefined;
  const perHostConcurrencyRaw = getFlag("--per-host-concurrency", "");
  const perHostConcurrency = perHostConcurrencyRaw ? parseInt(perHostConcurrencyRaw, 10) : undefined;
  const sessionWarmup = hasFlag("--session-warmup");
  setDebugEnabled(hasFlag("--debug-log"));

  const excludeUrlsFile = getFlag("--exclude-urls-file", "");
  let excludeUrls: string[] | undefined;
  if (excludeUrlsFile) {
    const content = fs.readFileSync(excludeUrlsFile, "utf8");
    excludeUrls = content.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("http"));
  }

  const stealthConfigRaw = getFlag("--stealth-config", "");
  let stealthConfig: Record<string, boolean> | undefined;
  if (stealthConfigRaw) {
    try {
      const parsed = JSON.parse(stealthConfigRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        stealthConfig = parsed;
      }
    } catch {
      console.error("Error: --stealth-config must be valid JSON");
      process.exit(1);
    }
  }

  const config: CrawlConfig = {
    startUrl: url,
    maxRequests,
    concurrency,
    mode,
    headless,
    ...(userAgent ? { userAgent } : {}),
    ...(respectRobots ? { respectRobots } : {}),
    ...(delay > 0 ? { delay } : {}),
    ...(customHeaders ? { customHeaders } : {}),
    ...(urls ? { urls } : {}),
    ...(browserProfile ? { browserProfile } : {}),
    ...(downloadOgImage ? { downloadOgImage } : {}),
    ...(scraperRules ? { scraperRules } : {}),
    ...(captureVitals ? { captureVitals } : {}),
    ...(stealthConfig ? { stealthConfig } : {}),
    ...(perHostDelay !== undefined && !Number.isNaN(perHostDelay) ? { perHostDelay } : {}),
    ...(perHostDelayMax !== undefined && !Number.isNaN(perHostDelayMax) ? { perHostDelayMax } : {}),
    ...(perHostConcurrency !== undefined && !Number.isNaN(perHostConcurrency) ? { perHostConcurrency } : {}),
    ...(sessionWarmup ? { sessionWarmup } : {}),
    ...(excludeUrls?.length ? { excludeUrls } : {}),
  };

  startMetricEmitter(1000);
  runCrawler(config)
    .then(() => {
      stopMetricEmitter();
      process.exit(0);
    })
    .catch((err) => {
      log("error", "crawler threw", { error: String(err?.message ?? err), stack: err?.stack });
      stopMetricEmitter();
      console.error("Crawler error:", err);
      process.exit(1);
    });
} else {
  console.error(
    "Usage:\n" +
    "  fera-crawler crawl <url> [options]\n" +
    "  fera-crawler open-browser <url> [--browser-profile PATH]"
  );
  process.exit(1);
}
