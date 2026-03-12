import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureServer, stopServer, runCrawlerProcess, BASE_URL } from "../helpers.js";

describe("SEO elements", () => {
  beforeAll(async () => {
    await ensureServer();
  });

  afterAll(() => {
    stopServer();
  });

  it("detects missing title", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/no-title`,
      "--mode", "list",
      "--urls", `${BASE_URL}/no-title`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("");
    expect(results[0].h1).toBe("Page Without Title");
    expect(results[0].metaDescription).toBe("Page with no title tag");
  });

  it("detects missing h1", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/no-h1`,
      "--mode", "list",
      "--urls", `${BASE_URL}/no-h1`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Page Without H1");
    expect(results[0].h1).toBe("");
    expect(results[0].metaDescription).toBe("Page with no h1 tag");
  });

  it("extracts non-self-referencing canonical", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/canonical`,
      "--mode", "list",
      "--urls", `${BASE_URL}/canonical`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].canonical).toBe("https://example.com/canonical-target");
  });

  it("counts only external links on external-links page", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/external-links`,
      "--mode", "list",
      "--urls", `${BASE_URL}/external-links`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].internalLinks).toBe(0);
    expect(results[0].externalLinks).toBe(3);
  });
});
