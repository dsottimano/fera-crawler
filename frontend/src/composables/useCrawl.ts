import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDatabase } from "./useDatabase";
import type { CrawlResult, CrawlConfig } from "../types/crawl";

export function useCrawl() {
  const results = ref<CrawlResult[]>([]);
  const crawling = ref(false);
  const currentSessionId = ref<number | null>(null);
  let unlistenResult: (() => void) | null = null;
  let unlistenComplete: (() => void) | null = null;

  const {
    createSession,
    completeSession,
    insertResult,
    loadSessionResults,
  } = useDatabase();

  async function startCrawl(url: string, config: CrawlConfig) {
    // Kill any sign-in browser first — can't share the profile directory
    try {
      await invoke("close_browser");
    } catch {}
    // Give Chromium a moment to fully release the profile lock
    await new Promise((r) => setTimeout(r, 500));

    // Clean up any prior listeners before registering new ones
    cleanup();

    results.value = [];
    crawling.value = true;

    // Create a DB session for this crawl
    const sessionId = await createSession(url);
    currentSessionId.value = sessionId;

    unlistenResult = await listen<CrawlResult>("crawl-result", async (event) => {
      results.value.push(event.payload);
      // Persist each result to SQLite as it arrives
      try {
        await insertResult(sessionId, event.payload);
      } catch (e) {
        console.error("DB insert failed:", e);
      }
    });

    unlistenComplete = await listen<void>("crawl-complete", async () => {
      crawling.value = false;
      try {
        await completeSession(sessionId);
      } catch (e) {
        console.error("DB session complete failed:", e);
      }
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
        headless: config.headless,
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
    if (currentSessionId.value) {
      try {
        await completeSession(currentSessionId.value);
      } catch (e) {
        console.error("DB session complete failed:", e);
      }
    }
    crawling.value = false;
    cleanup();
  }

  async function clearResults() {
    if (currentSessionId.value) {
      try {
        await completeSession(currentSessionId.value);
      } catch (e) {
        console.error("DB session complete on clear failed:", e);
      }
    }
    results.value = [];
    currentSessionId.value = null;
  }

  function setResults(data: CrawlResult[]) {
    results.value = data;
  }

  async function loadSession(sessionId: number) {
    results.value = await loadSessionResults(sessionId);
    currentSessionId.value = sessionId;
  }

  function cleanup() {
    if (unlistenResult) {
      unlistenResult();
      unlistenResult = null;
    }
    if (unlistenComplete) {
      unlistenComplete();
      unlistenComplete = null;
    }
  }

  return {
    results,
    crawling,
    currentSessionId,
    startCrawl,
    stopCrawl,
    clearResults,
    setResults,
    loadSession,
  };
}
