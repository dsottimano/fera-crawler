import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureServer, stopServer, runCrawlerProcess, findResult, BASE_URL } from "../helpers.js";

describe("list mode", () => {
  beforeAll(async () => {
    await ensureServer();
  });

  afterAll(() => {
    stopServer();
  });

  it("crawls only the specified URLs", async () => {
    const urls = [`${BASE_URL}/`, `${BASE_URL}/about`];
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/`,
      "--mode", "list",
      "--urls", urls.join(","),
      "--max-requests", "10",
    ]);

    expect(results).toHaveLength(2);
    const crawledUrls = results.map((r) => r.url).sort();
    expect(crawledUrls).toEqual(urls.sort());
  });

  it("does not follow links in list mode", async () => {
    // index.html has links to about, external-links, deep/nested-page
    // but in list mode we should only get index
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/`,
      "--mode", "list",
      "--urls", `${BASE_URL}/`,
      "--max-requests", "10",
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe(`${BASE_URL}/`);
  });
});
