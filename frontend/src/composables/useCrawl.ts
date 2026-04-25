import { ref, triggerRef } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDatabase } from "./useDatabase";
import { useConfig } from "./useConfig";
import { useSettings } from "./useSettings";
import { useDebug } from "./useDebug";
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
    getSessionStatus,
  } = useDatabase();

  async function startCrawl(
    url: string,
    opts: {
      resume?: boolean;
      replaceUrls?: Set<string>;
      // Per-call overrides of profile settings — for features like recrawl
      // (mode=list, maxRequests=urls.length) and Exact-URL scope switching.
      mode?: "spider" | "list";
      urls?: string[];
      maxRequests?: number;
    } = {},
  ) {
    const { config } = useConfig();
    const resume = opts.resume ?? false;
    const replaceUrls = opts.replaceUrls;

    // Kill any sign-in browser first — can't share the profile directory
    try {
      await invoke("close_browser");
    } catch {}
    // Give Chromium a moment to fully release the profile lock
    await new Promise((r) => setTimeout(r, 500));

    // Clean up any prior listeners before registering new ones
    cleanup();

    // On resume, keep existing results and build a set of already-visited URLs
    // to deduplicate incoming results AND skip them in the sidecar (so it
    // doesn't waste time re-fetching). Recrawl targets and the explicit list
    // (Exact URL scope, list mode) are exempt — those URLs need fresh data.
    const visitedUrls = new Set<string>();
    const explicitUrls = new Set(opts.urls ?? []);
    if (resume) {
      for (const r of results.value) {
        if (replaceUrls?.has(r.url)) continue;
        if (explicitUrls.has(r.url)) continue;
        // Parked stubs aren't real crawls — let the sidecar try them again.
        if (r.error?.startsWith("host_blocked_by_detector")) continue;
        visitedUrls.add(r.url);
      }
    } else {
      results.value = [];
      // Fresh crawl — recrawl queue from a prior crawl no longer applies.
      // Without this, the badge shows a stale count and the Recrawl Queue
      // tab is filled with URLs that aren't in this session's results.
      if (config.recrawlQueue.length > 0) {
        config.recrawlQueue = [];
      }
    }
    crawling.value = true;
    stopped.value = false;

    // Create a DB session (or reuse current for resume).
    //
    // Guard: if resume:true was requested AND there are results in memory but
    // currentSessionId is null, that's a data-fragmentation footgun — those
    // results would silently land in a fresh session, leaving the original
    // orphaned. Refuse instead. Caller should either Clear or rehydrate the
    // session via Crawl Manager → Open before resuming.
    let sessionId: number;
    if (resume && currentSessionId.value) {
      sessionId = currentSessionId.value;
      await updateSessionConfig(sessionId, config);
    } else if (resume && results.value.length > 0) {
      crawling.value = false;
      cleanup();
      const msg =
        "Can't resume: no active session is bound to this view. " +
        "Either Clear results, or open the original session from Crawl Manager.";
      console.error(msg);
      throw new Error(msg);
    } else {
      sessionId = await createSession(url, config);
      currentSessionId.value = sessionId;
    }

    unlistenResult = await listen<CrawlResult>("crawl-result", async (event) => {
      // Skip URLs already crawled (happens during resume) — except when the
      // existing row is a parked stub from the block detector. Those rows
      // need to be replaced when the host is later resumed and the URL
      // actually gets crawled.
      if (visitedUrls.has(event.payload.url)) {
        const existingIdx = results.value.findIndex(r => r.url === event.payload.url);
        if (existingIdx >= 0 && results.value[existingIdx].error?.startsWith("host_blocked_by_detector")) {
          results.value[existingIdx] = event.payload;
          scheduleRefresh();
          insertResult(sessionId, event.payload);
        }
        return;
      }
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

      // Remove from recrawl queue if present.
      const queueIdx = config.recrawlQueue.indexOf(event.payload.url);
      if (queueIdx >= 0) {
        config.recrawlQueue.splice(queueIdx, 1);
      } else if (replaceUrls?.has(event.payload.url)) {
        // Diagnostic: replaceUrls says this URL was a recrawl target, but
        // it's not in the queue. Likely a redirect-changed-url mismatch
        // (page.goto() returned a different URL than we sent in). Log so
        // the cause is visible if a recrawl run leaves the queue stuck.
        console.warn("recrawl URL emitted with no matching queue entry — possible redirect mismatch", {
          emitted: event.payload.url,
          replaceUrlsSize: replaceUrls.size,
        });
      }

      insertResult(sessionId, event.payload);
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
      // Persist the post-run config (drained recrawl queue, etc.) — without
      // this, reopening the session restores the pre-run queue from DB and
      // it looks like the recrawl didn't actually happen.
      try {
        await updateSessionConfig(sessionId, config);
      } catch (e) {
        console.error("DB config save on complete failed:", e);
      }

      // Safety-net: reconcile the recrawl queue against fresh results. If a
      // recrawl URL was successfully crawled in this run (we have a status>0
      // result for it) but it's still in the queue, the per-event drain
      // missed it — drain it here so the user doesn't end up with a phantom
      // pending count on completion.
      if (replaceUrls && replaceUrls.size > 0 && config.recrawlQueue.length > 0) {
        const drained: string[] = [];
        const remaining: string[] = [];
        for (const url of config.recrawlQueue) {
          if (replaceUrls.has(url)) {
            const r = results.value.find((x) => x.url === url);
            if (r && r.status > 0 && !r.error) {
              drained.push(url);
              continue;
            }
          }
          remaining.push(url);
        }
        if (drained.length > 0) {
          console.warn(
            `recrawl post-mortem: ${drained.length} URLs had fresh results but stayed in queue — draining now`,
            drained.slice(0, 5),
          );
          config.recrawlQueue = remaining;
        }
      }

      // Was anything in this run actually a failure (4xx/5xx, network error,
      // parked stub)? Distinguishes "dirty completion" (some URLs to retry)
      // from "clean completion" (all URLs finished cleanly).
      const hadFailures = results.value.some((r) =>
        r.status >= 400 ||
        r.status === 0 ||
        !!r.error,
      );
      if (hadFailures) {
        stopped.value = true;
      }
      // Clear recrawl queue — all done. (Keep it if we ended dirty; user
      // may want to resume-recrawl those.)
      if (!hadFailures && config.recrawlQueue.length > 0) {
        config.recrawlQueue = [];
      }
      cleanup();
    });

    // Crawl knobs live in the active profile (persistent). Transient per-crawl
    // state (list URLs, custom auth headers, live scraper rules, recrawl queue)
    // stays in useConfig. Per-call overrides beat both.
    const { settings } = useSettings();
    const s = settings.value;
    const { userAgent: stealthUa, ...stealthPatches } = s.stealth;
    const stealthConfig = JSON.stringify(stealthPatches);

    const mode = opts.mode ?? s.crawling.mode;
    const urls = opts.urls ?? config.urls;
    const maxRequests = opts.maxRequests ?? s.crawling.maxRequests;

    try {
      await invoke("start_crawl", {
        url,
        maxRequests,
        concurrency: s.crawling.concurrency,
        userAgent: stealthUa || null,
        respectRobots: s.crawling.respectRobots,
        delay: s.crawling.delay,
        customHeaders: Object.keys(config.customHeaders).length
          ? JSON.stringify(config.customHeaders)
          : null,
        mode,
        urls: urls.length ? urls : null,
        headless: s.authentication.headless,
        downloadOgImage: s.extraction.downloadOgImage || null,
        scraperRules: config.scraperRules.length
          ? JSON.stringify(config.scraperRules)
          : null,
        stealthConfig,
        perHostDelay: s.performance.perHostDelay,
        perHostConcurrency: s.performance.perHostConcurrency,
        sessionWarmup: s.performance.sessionWarmup || null,
        excludeUrls: visitedUrls.size ? Array.from(visitedUrls) : null,
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
      const { config } = useConfig();
      try {
        await updateSessionConfig(currentSessionId.value, config);
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
    // Recrawl queue belongs to the cleared session — drop it so the badge
    // doesn't carry into the next crawl.
    const { config } = useConfig();
    if (config.recrawlQueue.length > 0) {
      config.recrawlQueue = [];
    }
    // Stale logs would now refer to results that are gone — clear them too.
    useDebug().clearLogs();
  }

  function setResults(data: CrawlResult[]) {
    results.value = data;
  }

  async function loadSession(sessionId: number): Promise<CrawlConfig | null> {
    // Loaded sessions don't carry the live crawl's debug log — clear so the
    // panel reflects what the user is now viewing, not the prior run.
    useDebug().clearLogs();

    const loaded = await loadSessionResults(sessionId);
    results.value = loaded;
    currentSessionId.value = sessionId;
    const savedConfig = await loadSessionConfig(sessionId);

    // Detect partial coverage so the UI shows RESUME / STOPPED instead of
    // START / COMPLETE. List-mode: fewer crawled than queued. Spider-mode:
    // session was never completed (Stop, crash, or load before finish).
    const status = await getSessionStatus(sessionId);
    const listTotal = savedConfig?.urls?.length ?? 0;
    const isPartial = listTotal > 0
      ? loaded.length < listTotal
      : status.completed_at == null && loaded.length > 0;
    stopped.value = isPartial;

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
