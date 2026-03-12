import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureServer, stopServer, runCrawlerProcess, findResult, BASE_URL } from "../helpers.js";

describe("basic crawl", () => {
  beforeAll(async () => {
    await ensureServer();
  });

  afterAll(() => {
    stopServer();
  });

  it("crawls a single page and returns all CrawlResult fields", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/`,
      "--mode", "list",
      "--urls", `${BASE_URL}/`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    const r = results[0];

    // URL and status
    expect(r.url).toBe(`${BASE_URL}/`);
    expect(r.status).toBe(200);

    // SEO fields
    expect(r.title).toBe("Fera Test Home");
    expect(r.h1).toBe("Welcome to Fera Test Site");
    expect(r.metaDescription).toBe("Homepage for testing the Fera crawler");
    expect(r.canonical).toBe("http://localhost:5000/");

    // Links: 3 internal (about, external-links, nested-page), 1 external (example.com)
    expect(r.internalLinks).toBe(3);
    expect(r.externalLinks).toBe(1);

    // Response metadata
    expect(r.responseTime).toBeGreaterThan(0);
    expect(r.contentType).toContain("text/html");
    expect(r.resourceType).toBe("HTML");
    expect(r.size).toBeGreaterThan(0);

    // No error
    expect(r.error).toBeUndefined();
  });
});
