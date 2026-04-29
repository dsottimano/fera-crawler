import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureServer, stopServer, runCrawlerProcess, BASE_URL } from "../helpers.js";

describe("Robots directives", () => {
  beforeAll(async () => {
    await ensureServer();
  });

  afterAll(() => {
    stopServer();
  });

  it("parses meta robots with multiple directives", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/robots-directives`,
      "--mode", "list",
      "--urls", `${BASE_URL}/robots-directives`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.metaRobots).toContain("index");
    expect(r.metaRobots).toContain("follow");
    expect(r.metaRobots).toContain("max-image-preview:large");
    expect(r.isIndexable).toBe(true);
    expect(r.isNoindex).toBe(false);
    expect(r.isNofollow).toBe(false);
  });

  it("parses meta googlebot", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/robots-directives`,
      "--mode", "list",
      "--urls", `${BASE_URL}/robots-directives`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].metaGooglebot).toContain("max-image-preview:large");
  });

  it("detects noindex and nofollow from meta robots", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/noindex-page`,
      "--mode", "list",
      "--urls", `${BASE_URL}/noindex-page`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.metaRobots).toContain("noindex");
    expect(r.metaRobots).toContain("nofollow");
    expect(r.isIndexable).toBe(false);
    expect(r.isNoindex).toBe(true);
    expect(r.isNofollow).toBe(true);
  });

  it("detects noindex from X-Robots-Tag header", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/x-robots-noindex`,
      "--mode", "list",
      "--urls", `${BASE_URL}/x-robots-noindex`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.xRobotsTag).toContain("noindex");
    expect(r.isIndexable).toBe(false);
    expect(r.isNoindex).toBe(true);
    expect(r.isNofollow).toBe(true);
  });

  it("reports indexable for page with no robots restrictions", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/`,
      "--mode", "list",
      "--urls", `${BASE_URL}/`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.isIndexable).toBe(true);
    expect(r.isNoindex).toBe(false);
  });
});
