import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureServer, stopServer, runCrawlerProcess, BASE_URL } from "../helpers.js";

describe("Date extraction", () => {
  beforeAll(async () => {
    await ensureServer();
  });

  afterAll(() => {
    stopServer();
  });

  it("extracts article:published_time and article:modified_time", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/dates-page`,
      "--mode", "list",
      "--urls", `${BASE_URL}/dates-page`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.datePublished).toBe("15-06-2024");
    expect(r.datePublishedTime).toBe("10:30:00 UTC");
    expect(r.dateModified).toBe("20-07-2024");
    expect(r.dateModifiedTime).toBe("14:45:00 UTC");
  });

  it("extracts dates from JSON-LD when no meta tags present", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/dates-jsonld`,
      "--mode", "list",
      "--urls", `${BASE_URL}/dates-jsonld`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.datePublished).toBe("25-12-2023");
    expect(r.datePublishedTime).toBe("08:00:00 UTC");
    expect(r.dateModified).toBe("10-01-2024");
    expect(r.dateModifiedTime).toBe("16:30:00 UTC");
  });

  it("returns empty dates when no date metadata exists", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/about`,
      "--mode", "list",
      "--urls", `${BASE_URL}/about`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].datePublished).toBe("");
    expect(results[0].dateModified).toBe("");
    expect(results[0].datePublishedTime).toBe("");
    expect(results[0].dateModifiedTime).toBe("");
  });
});
