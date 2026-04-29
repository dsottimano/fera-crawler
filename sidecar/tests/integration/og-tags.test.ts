import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureServer, stopServer, runCrawlerProcess, BASE_URL } from "../helpers.js";

describe("Open Graph tags", () => {
  beforeAll(async () => {
    await ensureServer();
  });

  afterAll(() => {
    stopServer();
  });

  it("extracts all og: meta tags", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/og-tags`,
      "--mode", "list",
      "--urls", `${BASE_URL}/og-tags`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.ogTitle).toBe("OG Title Here");
    expect(r.ogDescription).toBe("OG description for testing");
    expect(r.ogType).toBe("article");
    expect(r.ogUrl).toBe("http://localhost:5000/og-tags");
    expect(r.ogImage).toBe("http://localhost:5000/assets/pixel.png");
  });

  it("extracts og:image width and height from meta tags", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/og-tags`,
      "--mode", "list",
      "--urls", `${BASE_URL}/og-tags`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].ogImageWidth).toBe(1200);
    expect(results[0].ogImageHeight).toBe(630);
  });

  it("returns empty og fields when no og tags present", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/about`,
      "--mode", "list",
      "--urls", `${BASE_URL}/about`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.ogTitle).toBe("");
    expect(r.ogDescription).toBe("");
    expect(r.ogImage).toBe("");
    expect(r.ogImageWidth).toBe(0);
    expect(r.ogImageHeight).toBe(0);
  });
});
