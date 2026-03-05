import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CrawlResult, CrawlConfig } from "../types/crawl";

export function useCrawl() {
  const results = ref<CrawlResult[]>([]);
  const crawling = ref(false);
  let unlisten: (() => void) | null = null;

  async function startCrawl(url: string, config: CrawlConfig) {
    results.value = [];
    crawling.value = true;

    unlisten = await listen<CrawlResult>("crawl-result", (event) => {
      results.value.push(event.payload);
    });

    await listen<void>("crawl-complete", () => {
      crawling.value = false;
      cleanup();
    });

    try {
      await invoke("start_crawl", {
        url,
        maxRequests: config.maxRequests,
        concurrency: config.concurrency,
        userAgent: config.userAgent || null,
        respectRobots: config.respectRobots,
        delay: config.delay,
        customHeaders: Object.keys(config.customHeaders).length
          ? JSON.stringify(config.customHeaders)
          : null,
        mode: config.mode,
        urls: config.urls.length ? config.urls : null,
      });
    } catch (e) {
      console.error("Crawl failed:", e);
      crawling.value = false;
      cleanup();
    }
  }

  async function stopCrawl() {
    try {
      await invoke("stop_crawl");
    } catch (e) {
      console.error("Stop failed:", e);
    }
    crawling.value = false;
    cleanup();
  }

  function clearResults() {
    results.value = [];
  }

  function setResults(data: CrawlResult[]) {
    results.value = data;
  }

  function cleanup() {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  }

  return { results, crawling, startCrawl, stopCrawl, clearResults, setResults };
}
