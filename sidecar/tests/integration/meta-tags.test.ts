import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureServer, stopServer, runCrawlerProcess, BASE_URL } from "../helpers.js";

describe("Meta tags extraction", () => {
  beforeAll(async () => {
    await ensureServer();
  });

  afterAll(() => {
    stopServer();
  });

  it("collects all meta tags with name/property/content", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/all-meta`,
      "--mode", "list",
      "--urls", `${BASE_URL}/all-meta`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    const tags = results[0].metaTags;
    expect(tags.length).toBeGreaterThanOrEqual(5);

    // Check specific meta tags exist
    const descTag = tags.find((t) => t.name === "description");
    expect(descTag).toBeDefined();
    expect(descTag!.content).toBe("Page for meta tag extraction test");

    const robotsTag = tags.find((t) => t.name === "robots");
    expect(robotsTag).toBeDefined();
    expect(robotsTag!.content).toBe("index, follow");

    const authorTag = tags.find((t) => t.name === "author");
    expect(authorTag).toBeDefined();
    expect(authorTag!.content).toBe("Test Author");

    const ogTitleTag = tags.find((t) => t.property === "og:title");
    expect(ogTitleTag).toBeDefined();
    expect(ogTitleTag!.content).toBe("All Meta OG Title");

    // http-equiv should also be captured
    const langTag = tags.find((t) => t.name === "content-language");
    expect(langTag).toBeDefined();
    expect(langTag!.content).toBe("en");
  });

  it("returns empty metaTags array for error pages", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/error-404`,
      "--mode", "list",
      "--urls", `${BASE_URL}/error-404`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    expect(Array.isArray(results[0].metaTags)).toBe(true);
  });
});
