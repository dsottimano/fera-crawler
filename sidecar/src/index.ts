import { runCrawler } from "./crawler.js";

const args = process.argv.slice(2);

function getFlag(name: string, defaultVal: string): string {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return defaultVal;
  return args[idx + 1];
}

const command = args[0];

if (command !== "crawl" || !args[1]) {
  console.error("Usage: fera-crawler crawl <url> [--max-requests N] [--concurrency N]");
  process.exit(1);
}

const url = args[1];
const maxRequests = parseInt(getFlag("--max-requests", "100"), 10);
const concurrency = parseInt(getFlag("--concurrency", "5"), 10);

runCrawler({ startUrl: url, maxRequests, concurrency })
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("Crawler error:", err);
    process.exit(1);
  });
