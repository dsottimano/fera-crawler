import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureServer, stopServer, runCrawlerProcess, BASE_URL } from "../helpers.js";

describe("Outlinks and content extraction", () => {
  beforeAll(async () => {
    await ensureServer();
  });

  afterAll(() => {
    stopServer();
  });

  it("collects deduplicated outlinks", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/outlinks-page`,
      "--mode", "list",
      "--urls", `${BASE_URL}/outlinks-page`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    const r = results[0];

    // 5 total anchors, but /about appears twice — outlinks should be deduplicated
    expect(r.outlinks.length).toBeLessThan(5);
    expect(r.outlinks).toContain(`${BASE_URL}/about`);
    expect(r.outlinks).toContain("https://example.com/");
    expect(r.outlinks).toContain("https://google.com/");
    expect(r.outlinks).toContain("https://github.com/");
  });

  it("counts internal and external links correctly", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/outlinks-page`,
      "--mode", "list",
      "--urls", `${BASE_URL}/outlinks-page`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    // 2 internal anchors (duplicate /about counted twice), 3 external
    expect(results[0].internalLinks).toBe(2);
    expect(results[0].externalLinks).toBe(3);
  });

  it("computes word count from visible text", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/outlinks-page`,
      "--mode", "list",
      "--urls", `${BASE_URL}/outlinks-page`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    // Should have >0 words from body text + link text
    expect(results[0].wordCount).toBeGreaterThan(5);
  });

  it("extracts h2 tag", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/all-meta`,
      "--mode", "list",
      "--urls", `${BASE_URL}/all-meta`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].h2).toBe("A Secondary Heading");
  });

  it("returns empty h2 when none exists", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/about`,
      "--mode", "list",
      "--urls", `${BASE_URL}/about`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].h2).toBe("");
  });
});
