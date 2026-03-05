import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CrawlResult } from "../types/crawl";

export function useCrawl() {
  const results = ref<CrawlResult[]>([]);
  const crawling = ref(false);
  let unlisten: (() => void) | null = null;

  async function startCrawl(url: string, maxRequests: number, concurrency: number) {
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
      await invoke("start_crawl", { url, maxRequests, concurrency });
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

  function cleanup() {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  }

  return { results, crawling, startCrawl, stopCrawl };
}
