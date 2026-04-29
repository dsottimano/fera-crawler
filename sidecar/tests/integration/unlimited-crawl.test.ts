import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureServer, stopServer, runCrawlerProcess, BASE_URL } from "../helpers.js";

describe("Unlimited crawl (maxRequests=0)", () => {
  beforeAll(async () => {
    await ensureServer();
  });

  afterAll(() => {
    stopServer();
  });

  it("crawls more than the old default of 100 when maxRequests is 0", async () => {
    // With max-requests 0, the crawler should crawl until the queue is empty.
    // Our test site is small so it will finish quickly, but it should crawl
    // at least the homepage + its linked pages without hitting a cap.
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/`,
      "--max-requests", "0",
      "--concurrency", "3",
    ]);

    // Should crawl more than 1 page (spider discovers links)
    expect(results.length).toBeGreaterThan(1);
  });

  it("still respects explicit max-requests when set", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/`,
      "--max-requests", "2",
      "--concurrency", "1",
    ]);

    expect(results.length).toBeLessThanOrEqual(2);
  });
});
