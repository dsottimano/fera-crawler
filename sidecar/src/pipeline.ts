import type { CrawlResult } from "./types.js";

export function writeLine(result: CrawlResult): void {
  const line = JSON.stringify(result);
  process.stdout.write(line + "\n");
}
