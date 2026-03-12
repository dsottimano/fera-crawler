import { runCrawler, openBrowser, dumpProfile } from "./crawler.js";
import type { CrawlConfig } from "./types.js";

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
  const maxRequests = parseInt(getFlag("--max-requests", "100"), 10);
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

  const urls = urlsRaw ? urlsRaw.split(",").map((u) => u.trim()) : undefined;
  const headlessRaw = getFlag("--headless", "true");
  const headless = headlessRaw !== "false";

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
  };

  runCrawler(config)
    .then(() => process.exit(0))
    .catch((err) => {
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
