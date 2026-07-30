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

    // Crawl depth: the start URL is a seed (0); /about is linked from it (1).
    const start = results.find((r) => r.url === `${BASE_URL}/`);
    expect(start!.crawlDepth).toBe(0);
    expect(about!.crawlDepth).toBe(1);
  });

  // Scope is derived from the seed BEFORE navigation, so a seed that redirects
  // to another host must rebase it. Without that, every link on the destination
  // host is out of scope and the spider stops after the seed with 0 internal
  // links. localhost -> 127.0.0.1 is a host change under `domain` scope.
  it("rebases scope onto the seed's post-redirect host", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/redirect-cross-host`,
      "--mode", "spider",
      "--scope", "domain",
      "--max-requests", "5",
    ]);

    const seed = results.find((r) => r.url.includes("/redirect-cross-host"));
    expect(seed).toBeDefined();
    expect(seed!.internalLinks).toBeGreaterThan(0);
    // Links on the destination host were followed, not written off as external.
    expect(results.length).toBeGreaterThan(1);
    expect(results.some((r) => r.url.startsWith("http://127.0.0.1:5000/"))).toBe(true);
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
