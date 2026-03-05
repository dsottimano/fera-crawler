import { PlaywrightCrawler, type PlaywrightCrawlingContext } from "@crawlee/playwright";
import { writeLine } from "./pipeline.js";
import { classifyResource } from "./utils.js";
import type { CrawlConfig, CrawlResult } from "./types.js";

export async function runCrawler(config: CrawlConfig): Promise<void> {
  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: config.maxRequests,
    maxConcurrency: config.concurrency,
    headless: true,
    requestHandlerTimeoutSecs: 30,

    // TODO: Crawlee's PlaywrightCrawler does not natively support robots.txt.
    // config.respectRobots is accepted but not yet enforced. Implement custom
    // robots.txt checking in a future update.

    launchContext: {
      launchOptions: {
        args: ["--no-sandbox"],
      },
      ...(config.userAgent ? { userAgent: config.userAgent } : {}),
    },

    preNavigationHooks: [
      async ({ page }, goToOptions) => {
        // Apply custom headers if configured
        if (config.customHeaders && Object.keys(config.customHeaders).length > 0) {
          await page.setExtraHTTPHeaders(config.customHeaders);
        }

        // Apply inter-request delay if configured
        if (config.delay && config.delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, config.delay));
        }
      },
    ],

    async requestHandler({ request, page, enqueueLinks }: PlaywrightCrawlingContext) {
      const startTime = Date.now();

      const response = await page.goto(request.url, { waitUntil: "domcontentloaded" });
      const responseTime = Date.now() - startTime;
      const status = response?.status() ?? 0;
      const contentType = response?.headers()["content-type"] ?? "";
      const resourceType = classifyResource(contentType);

      // Get response body size
      let size = 0;
      try {
        const body = await response?.body();
        size = body ? body.length : 0;
      } catch {
        // body may not be available for some responses
      }

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
        resourceType,
        size,
      };

      writeLine(result);

      // Only enqueue discovered links in spider mode
      if (config.mode === "spider") {
        await enqueueLinks({
          strategy: "same-hostname",
        });
      }
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
        resourceType: "Other",
        size: 0,
        error: error.message,
      };
      writeLine(result);
    },
  });

  // In list mode, crawl the provided URLs; in spider mode, start from startUrl
  if (config.mode === "list" && config.urls && config.urls.length > 0) {
    await crawler.run(config.urls);
  } else {
    await crawler.run([config.startUrl]);
  }
}
