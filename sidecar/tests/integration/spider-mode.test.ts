import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureServer, stopServer, runCrawlerProcess, findResult, BASE_URL } from "../helpers.js";

describe("spider mode", () => {
  beforeAll(async () => {
    await ensureServer();
  });

  afterAll(() => {
    stopServer();
  });

  it("discovers and crawls linked pages", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/`,
      "--mode", "spider",
      "--max-requests", "10",
      "--concurrency", "2",
    ]);

    // Should have crawled more than just the start page
    expect(results.length).toBeGreaterThan(1);

    // index.html links to /about, /external-links, /deep/nested-page
    const urls = results.map((r) => r.url);
    expect(urls).toContain(`${BASE_URL}/`);
    expect(urls).toContain(`${BASE_URL}/about`);

    // Verify discovered pages have correct data
    const about = findResult(results, "/about");
    expect(about).toBeDefined();
    expect(about!.title).toBe("About - Fera Test");
    expect(about!.status).toBe(200);
  });

  it("does not exceed maxRequests", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/`,
      "--mode", "spider",
      "--max-requests", "2",
    ]);

    expect(results.length).toBeLessThanOrEqual(2);
  });
});
