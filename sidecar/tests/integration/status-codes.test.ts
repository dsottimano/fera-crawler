import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureServer, stopServer, runCrawlerProcess, BASE_URL } from "../helpers.js";

describe("status codes", () => {
  beforeAll(async () => {
    await ensureServer();
  });

  afterAll(() => {
    stopServer();
  });

  it("reports 404 status for missing pages", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/error-404`,
      "--mode", "list",
      "--urls", `${BASE_URL}/error-404`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe(404);
    expect(results[0].title).toBe("Not Found");
  });

  it("reports 500 status for server errors", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/error-500`,
      "--mode", "list",
      "--urls", `${BASE_URL}/error-500`,
      "--max-requests", "1",
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe(500);
    expect(results[0].title).toBe("Server Error");
  });
});
