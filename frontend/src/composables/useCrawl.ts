import { ref, triggerRef } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDatabase } from "./useDatabase";
import { useConfig } from "./useConfig";
import { useSettings } from "./useSettings";
import type { CrawlResult, CrawlConfig } from "../types/crawl";

const results = ref<CrawlResult[]>([]);
const crawling = ref(false);
const stopped = ref(false);
const currentSessionId = ref<number | null>(null);
let unlistenResult: (() => void) | null = null;
let unlistenComplete: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    triggerRef(results);
  }, 500);
}

export function useCrawl() {
  const {
    createSession,
    completeSession,
    insertResult,
    loadSessionResults,
    loadSessionConfig,
    updateSessionConfig,
  } = useDatabase();

  async function startCrawl(url: string, config: CrawlConfig, resume = false, replaceUrls?: Set<string>) {
    const { config: appConfig } = useConfig();

    // Kill any sign-in browser first — can't share the profile directory
    try {
      await invoke("close_browser");
    } catch {}
    // Give Chromium a moment to fully release the profile lock
    await new Promise((r) => setTimeout(r, 500));

    // Clean up any prior listeners before registering new ones
    cleanup();

    // On resume, keep existing results and build a set of already-visited URLs
    // to deduplicate incoming results (sidecar restarts from scratch).
    const visitedUrls = new Set<string>();
    if (resume) {
      for (const r of results.value) {
        // Don't mark recrawl targets as visited — we want fresh results
        if (!replaceUrls?.has(r.url)) {
          visitedUrls.add(r.url);
        }
      }
    } else {
      results.value = [];
    }
    crawling.value = true;
    stopped.value = false;

    // Create a DB session (or reuse current for resume)
    let sessionId: number;
    if (resume && currentSessionId.value) {
      sessionId = currentSessionId.value;
      await updateSessionConfig(sessionId, config);
    } else {
      sessionId = await createSession(url, config);
      currentSessionId.value = sessionId;
    }

    unlistenResult = await listen<CrawlResult>("crawl-result", async (event) => {
      // Skip URLs already crawled (happens during resume)
      if (visitedUrls.has(event.payload.url)) return;
      visitedUrls.add(event.payload.url);

      // Replace in-place for recrawled URLs, otherwise append
      const existingIdx = replaceUrls?.has(event.payload.url)
        ? results.value.findIndex(r => r.url === event.payload.url)
        : -1;
      if (existingIdx >= 0) {
        results.value[existingIdx] = event.payload;
      } else {
        results.value.push(event.payload);
      }
      scheduleRefresh();

      // Remove from recrawl queue if present
      const queueIdx = appConfig.recrawlQueue.indexOf(event.payload.url);
      if (queueIdx >= 0) {
        appConfig.recrawlQueue.splice(queueIdx, 1);
      }

      try {
        await insertResult(sessionId, event.payload);
      } catch (e) {
        console.error("DB insert failed:", e);
      }
    });

    unlistenComplete = await listen<void>("crawl-complete", async () => {
      crawling.value = false;
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
      triggerRef(results);
      try {
        await completeSession(sessionId);
      } catch (e) {
        console.error("DB session complete failed:", e);
      }
      // Clear recrawl queue — all done
      if (appConfig.recrawlQueue.length > 0) {
        appConfig.recrawlQueue = [];
      }
      cleanup();
    });

    // Active profile settings. settings.value falls back to schema defaults
    // (stealth on, perHost 500/2, warmup off) when no profile has loaded yet.
    const { settings } = useSettings();
    const stealthConfig = JSON.stringify(settings.value.stealth);
    const perf = settings.value.performance;

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
        downloadOgImage: config.downloadOgImage || null,
        scraperRules: config.scraperRules.length
          ? JSON.stringify(config.scraperRules)
          : null,
        stealthConfig,
        perHostDelay: perf.perHostDelay,
        perHostConcurrency: perf.perHostConcurrency,
        sessionWarmup: perf.sessionWarmup || null,
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
    // Save current config (with updated recrawl queue) to DB
    if (currentSessionId.value) {
      const { config: appConfig } = useConfig();
      try {
        await updateSessionConfig(currentSessionId.value, appConfig);
      } catch (e) {
        console.error("Config save on stop failed:", e);
      }
    }
    // Don't complete session on stop — allow resume
    crawling.value = false;
    stopped.value = true;
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
    stopped.value = false;
  }

  function setResults(data: CrawlResult[]) {
    results.value = data;
  }

  async function loadSession(sessionId: number): Promise<CrawlConfig | null> {
    const loaded = await loadSessionResults(sessionId);
    results.value = loaded;
    currentSessionId.value = sessionId;
    const savedConfig = await loadSessionConfig(sessionId);
    return savedConfig;
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
    stopped,
    currentSessionId,
    startCrawl,
    stopCrawl,
    clearResults,
    setResults,
    loadSession,
  };
}
