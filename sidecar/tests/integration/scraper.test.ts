import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext } from "patchright";
import { findChromium } from "../../src/crawler.js";
import { crawlPage } from "../../src/crawler.js";
import { ensureServer, stopServer } from "../helpers.js";

describe("scraper extraction", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    await ensureServer();
    const executablePath = findChromium();
    browser = await chromium.launch({ headless: true, executablePath });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    stopServer();
  });

  it("extracts text and presence for matching selectors", async () => {
    const page = await context.newPage();

    try {
      const { result } = await crawlPage(page, "http://localhost:5000/scraper", {
        scraperRules: [
          { name: "headline", selector: "h1.main-headline" },
          { name: "price", selector: ".price" },
          { name: "missing", selector: ".nonexistent-class" },
        ],
      });

      expect(result.scraper.headline.value).toBe("Test Headline");
      expect(result.scraper.headline.appears).toBe(true);

      expect(result.scraper.price.value).toBe("$29.99");
      expect(result.scraper.price.appears).toBe(true);

      expect(result.scraper.missing.value).toBe("");
      expect(result.scraper.missing.appears).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("returns empty scraper object when no rules provided", async () => {
    const page = await context.newPage();

    try {
      const { result } = await crawlPage(page, "http://localhost:5000/scraper");
      expect(result.scraper).toEqual({});
    } finally {
      await page.close();
    }
  });
});
