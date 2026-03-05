import { PlaywrightCrawler, type PlaywrightCrawlingContext } from "@crawlee/playwright";
import { writeLine } from "./pipeline.js";
import type { CrawlResult } from "./types.js";

export interface CrawlerOptions {
  startUrl: string;
  maxRequests: number;
  concurrency: number;
}

export async function runCrawler(opts: CrawlerOptions): Promise<void> {
  const startHost = new URL(opts.startUrl).hostname;

  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: opts.maxRequests,
    maxConcurrency: opts.concurrency,
    headless: true,
    requestHandlerTimeoutSecs: 30,
    launchContext: {
      launchOptions: { args: ["--no-sandbox"] },
    },
    async requestHandler({ request, page, enqueueLinks }: PlaywrightCrawlingContext) {
      const startTime = Date.now();

      const response = await page.goto(request.url, { waitUntil: "domcontentloaded" });
      const responseTime = Date.now() - startTime;
      const status = response?.status() ?? 0;
      const contentType = response?.headers()["content-type"] ?? "";

      const data = await page.evaluate(() => {
        const title = document.querySelector("title")?.textContent?.trim() ?? "";
        const h1 = document.querySelector("h1")?.textContent?.trim() ?? "";
        const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() ?? "";
        const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? "";

        const links = Array.from(document.querySelectorAll("a[href]"));
        let internal = 0;
        let external = 0;
        for (const a of links) {
          try {
            const href = new URL((a as HTMLAnchorElement).href, location.origin);
            if (href.hostname === location.hostname) internal++;
            else external++;
          } catch {
            // skip malformed
          }
        }

        return { title, h1, metaDescription: metaDesc, canonical, internalLinks: internal, externalLinks: external };
      });

      const result: CrawlResult = {
        url: request.url,
        status,
        ...data,
        responseTime,
        contentType,
      };

      writeLine(result);

      await enqueueLinks({
        strategy: "same-hostname",
      });
    },

    failedRequestHandler({ request }, error) {
      const result: CrawlResult = {
        url: request.url,
        status: 0,
        title: "",
        h1: "",
        metaDescription: "",
        canonical: "",
        internalLinks: 0,
        externalLinks: 0,
        responseTime: 0,
        contentType: "",
        error: error.message,
      };
      writeLine(result);
    },
  });

  await crawler.run([opts.startUrl]);
}
