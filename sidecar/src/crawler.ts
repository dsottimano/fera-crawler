import path from "node:path";
import fs from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { writeLine } from "./pipeline.js";
import { classifyResource } from "./utils.js";
import type { CrawlConfig, CrawlResult } from "./types.js";

function findChromium(): string | undefined {
  const resourcesDir = process.env.FERA_RESOURCES_DIR;
  const candidates = [
    ...(resourcesDir ? [path.join(resourcesDir, "chromium", "chrome.exe")] : []),
    path.join(path.dirname(process.execPath), "chromium", "chrome.exe"),
    path.join(path.dirname(process.execPath), "..", "chromium", "chrome.exe"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

async function crawlPage(page: Page, url: string): Promise<{ result: CrawlResult; links: string[] }> {
  const startTime = Date.now();
  let status = 0;
  let contentType = "";
  let size = 0;
  let error: string | undefined;
  let links: string[] = [];

  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const responseTime = Date.now() - startTime;
    status = response?.status() ?? 0;
    contentType = response?.headers()["content-type"] ?? "";

    try {
      const body = await response?.body();
      size = body ? body.length : 0;
    } catch {}

    const data = await page.evaluate(() => {
      const title = document.querySelector("title")?.textContent?.trim() ?? "";
      const h1 = document.querySelector("h1")?.textContent?.trim() ?? "";
      const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() ?? "";
      const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? "";

      const anchors = Array.from(document.querySelectorAll("a[href]"));
      let internal = 0;
      let external = 0;
      const discoveredLinks: string[] = [];
      for (const a of anchors) {
        try {
          const href = new URL((a as HTMLAnchorElement).href, location.origin);
          if (href.hostname === location.hostname) {
            internal++;
            href.hash = "";
            discoveredLinks.push(href.href);
          } else {
            external++;
          }
        } catch {}
      }
      return { title, h1, metaDescription: metaDesc, canonical, internalLinks: internal, externalLinks: external, discoveredLinks };
    });

    links = data.discoveredLinks;

    return {
      result: {
        url,
        status,
        title: data.title,
        h1: data.h1,
        metaDescription: data.metaDescription,
        canonical: data.canonical,
        internalLinks: data.internalLinks,
        externalLinks: data.externalLinks,
        responseTime,
        contentType,
        resourceType: classifyResource(contentType),
        size,
      },
      links,
    };
  } catch (err: any) {
    return {
      result: {
        url,
        status: 0,
        title: "",
        h1: "",
        metaDescription: "",
        canonical: "",
        internalLinks: 0,
        externalLinks: 0,
        responseTime: Date.now() - startTime,
        contentType: "",
        resourceType: "Other",
        size: 0,
        error: err.message,
      },
      links: [],
    };
  }
}

export async function runCrawler(config: CrawlConfig): Promise<void> {
  const executablePath = findChromium();
  const browser: Browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const visited = new Set<string>();
  const queue: string[] = [];
  let processed = 0;

  if (config.mode === "list" && config.urls?.length) {
    queue.push(...config.urls);
  } else {
    queue.push(config.startUrl);
  }

  try {
    while (queue.length > 0 && processed < config.maxRequests) {
      const batch = queue.splice(0, config.concurrency);
      const tasks = batch
        .filter((url) => {
          if (visited.has(url)) return false;
          visited.add(url);
          return true;
        })
        .slice(0, config.maxRequests - processed);

      if (tasks.length === 0) continue;

      const results = await Promise.all(
        tasks.map(async (url) => {
          const page = await browser.newPage({
            ...(config.userAgent ? { userAgent: config.userAgent } : {}),
            ...(config.customHeaders ? { extraHTTPHeaders: config.customHeaders } : {}),
          });
          try {
            if (config.delay && config.delay > 0) {
              await new Promise((r) => setTimeout(r, config.delay));
            }
            return await crawlPage(page, url);
          } finally {
            await page.close();
          }
        }),
      );

      for (const { result, links } of results) {
        writeLine(result);
        processed++;
        if (config.mode === "spider") {
          for (const link of links) {
            if (!visited.has(link) && queue.length + processed < config.maxRequests) {
              queue.push(link);
            }
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
}
