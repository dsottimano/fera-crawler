import { ref, triggerRef } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDatabase } from "./useDatabase";
import { useSettings } from "./useSettings";
import { useDebug } from "./useDebug";
import type { CrawlResult } from "../types/crawl";
import type { SettingsValues } from "../settings/types";
import { decideCompletion } from "../utils/completionStatus";
import { buildStartCrawlPayload } from "../utils/startCrawlPayload";

const results = ref<CrawlResult[]>([]);
const crawling = ref(false);
const stopped = ref(false);
const currentSessionId = ref<number | null>(null);

/** Live aggregate from the Rust `crawl-progress` event (Phase 3). One
 *  module-scope listener feeds this; the data grid watches `rowCount` to
 *  offer a "X new rows" refresh and the health screen reads it directly. */
export interface CrawlProgress {
  rowCount: number;
  errorCount: number;
  lastUrl: string;
  latestStatuses: number[];
}
const crawlProgress = ref<CrawlProgress>({
  rowCount: 0,
  errorCount: 0,
  lastUrl: "",
  latestStatuses: [],
});

let progressUnlisten: (() => void) | null = null;
async function ensureProgressListener(): Promise<void> {
  if (progressUnlisten) return;
  progressUnlisten = await listen<CrawlProgress>("crawl-progress", (event) => {
    crawlProgress.value = event.payload;
  });
}
// Reset on every crawl start so the row count doesn't carry over from the
// previous crawl. Module-level so any caller that starts a crawl gets the
// reset without re-wiring.
function resetCrawlProgress() {
  crawlProgress.value = { rowCount: 0, errorCount: 0, lastUrl: "", latestStatuses: [] };
}
// When a saved crawl is loaded, its pinned settings snapshot lives here so
// resume/start/stop and the sidebar all read from the same source. Cleared on
// New Crawl so a fresh crawl falls back to the default settings.
const pinnedSettings = ref<SettingsValues | null>(null);
// Module-level latch: rehydrate the latest incomplete session ONCE per module
// load. HMR re-runs this module and re-fires the rehydration; production app
// reload does the same. The user can override by clicking Clear.
let rehydratePromise: Promise<void> | null = null;
// Bumped each time the lazy seo_json enrichment merges another batch into
// `results`. Watched by CrawlGrid so it can re-run setData; we can't rely on
// the existing length-watcher because in-place mutation keeps length the same.
const seoVersion = ref(0);
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
    loadSessionResults,
    loadSessionSeoBatch,
    loadSessionConfig,
    updateSessionConfig,
    getSessionStatus,
    getLatestIncompleteSession,
  } = useDatabase();

  // Wire the global crawl-progress listener once. Idempotent — subsequent
  // useCrawl() callers no-op.
  void ensureProgressListener();

  // Lazy first-call rehydration. Survives HMR + production reload because
  // the source of truth is the DB row, not in-memory refs.
  if (!rehydratePromise) {
    rehydratePromise = (async () => {
      try {
        const session = await getLatestIncompleteSession();
        if (!session) return;
        // Don't clobber an in-flight crawl that started before rehydrate finished.
        if (crawling.value || currentSessionId.value !== null) return;
        await loadSession(session.id);
      } catch (e) {
        console.error("Boot rehydration failed:", e);
      }
    })();
  }

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
    const { settings } = useSettings();
    // Pinned snapshot wins when a saved crawl is loaded; fresh crawls fall
    // back to the default settings. Single source of truth for both per-crawl
    // inputs (urls, headers, recrawl queue) and knobs (concurrency, delay…).
    const s: SettingsValues = pinnedSettings.value ?? settings.value;
    const inputs = s.inputs;
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
      if (inputs.recrawlQueue.length > 0) {
        inputs.recrawlQueue = [];
      }
    }
    crawling.value = true;
    stopped.value = false;
    resetCrawlProgress();

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
      await updateSessionConfig(sessionId, s);
    } else if (resume && results.value.length > 0) {
      crawling.value = false;
      cleanup();
      const msg =
        "Can't resume: no active session is bound to this view. " +
        "Either Clear results, or open the original session from Crawl Manager.";
      console.error(msg);
      throw new Error(msg);
    } else {
      sessionId = await createSession(url, s);
      currentSessionId.value = sessionId;
      // First crawl from the default-settings path — pin them so any
      // subsequent stop/resume/refresh on this session keeps using them
      // even if the user switches the default profile in the meantime.
      if (!pinnedSettings.value) {
        pinnedSettings.value = JSON.parse(JSON.stringify(s)) as SettingsValues;
      }
    }

    unlistenResult = await listen<CrawlResult>("crawl-result", async (event) => {
      // Skip URLs already crawled (happens during resume) — except when the
      // existing row is a parked stub from the block detector. Those rows
      // need to be replaced when the host is later resumed and the URL
      // actually gets crawled. DB writes for both branches are handled by
      // the Rust DbWriter (Phase 1) — JS only updates the in-memory view.
      if (visitedUrls.has(event.payload.url)) {
        const existingIdx = results.value.findIndex(r => r.url === event.payload.url);
        if (existingIdx >= 0 && results.value[existingIdx].error?.startsWith("host_blocked_by_detector")) {
          results.value[existingIdx] = event.payload;
          scheduleRefresh();
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

      const queueIdx = inputs.recrawlQueue.indexOf(event.payload.url);
      if (queueIdx >= 0) {
        inputs.recrawlQueue.splice(queueIdx, 1);
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
    });

    unlistenComplete = await listen<void>("crawl-complete", async () => {
      crawling.value = false;
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
      triggerRef(results);

      // Decide BEFORE writing to DB. A list-mode coverage gap (results <
      // listTotal) means resume-with-excludeUrls produced a no-op completion
      // — must NOT mark the session complete or the user loses their stopped
      // state. Same when any row is a failure.
      const decision = decideCompletion({
        results: results.value,
        listTotal: inputs.urls.length,
      });

      try {
        if (decision.isStopped) {
          stopped.value = true;
        } else {
          await completeSession(sessionId);
        }
      } catch (e) {
        console.error("DB session complete failed:", e);
      }
      try {
        await updateSessionConfig(sessionId, s);
      } catch (e) {
        console.error("DB config save on complete failed:", e);
      }

      if (replaceUrls && replaceUrls.size > 0 && inputs.recrawlQueue.length > 0) {
        const drained: string[] = [];
        const remaining: string[] = [];
        for (const url of inputs.recrawlQueue) {
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
          inputs.recrawlQueue = remaining;
        }
      }

      if (!decision.isStopped && inputs.recrawlQueue.length > 0) {
        inputs.recrawlQueue = [];
      }
      cleanup();
    });

    try {
      await invoke(
        "start_crawl",
        buildStartCrawlPayload(url, s, {
          mode: opts.mode,
          urls: opts.urls,
          maxRequests: opts.maxRequests,
          excludeUrls: visitedUrls,
          sessionId,
        }),
      );
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
    if (currentSessionId.value && pinnedSettings.value) {
      try {
        await updateSessionConfig(currentSessionId.value, pinnedSettings.value);
      } catch (e) {
        console.error("Config save on stop failed:", e);
      }
    }
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
    pinnedSettings.value = null;
    useDebug().clearLogs();
  }

  function setResults(data: CrawlResult[]) {
    results.value = data;
  }

  async function loadSession(sessionId: number): Promise<SettingsValues | null> {
    useDebug().clearLogs();

    const loaded = await loadSessionResults(sessionId);
    results.value = loaded;
    currentSessionId.value = sessionId;
    const snapshot = await loadSessionConfig(sessionId);
    // Pin so resume / stop / sidebar / config modal all read from this snapshot
    // instead of whatever the default-settings profile happens to be now.
    pinnedSettings.value = snapshot;

    const status = await getSessionStatus(sessionId);
    const listTotal = snapshot?.inputs.urls.length ?? 0;
    const isPartial = listTotal > 0
      ? loaded.length < listTotal
      : status.completed_at == null && loaded.length > 0;
    stopped.value = isPartial;

    void enrichSeo(sessionId, loaded);

    return snapshot;
  }

  // Lazily fills the seo_json-derived fields on rows already in `results`.
  // Runs after the grid paints so the user sees data immediately; aborts if
  // the active session changes (user loaded another crawl or started fresh).
  async function enrichSeo(sessionId: number, rows: CrawlResult[]): Promise<void> {
    const BATCH = 1000;
    for (let offset = 0; offset < rows.length; offset += BATCH) {
      if (currentSessionId.value !== sessionId) return;
      const seoStrs = await loadSessionSeoBatch(sessionId, offset, BATCH);
      if (currentSessionId.value !== sessionId) return;
      for (let i = 0; i < seoStrs.length; i++) {
        const row = rows[offset + i];
        if (!row) continue;
        let seo: any = {};
        try { seo = JSON.parse(seoStrs[i]); } catch {}
        row.metaGooglebot = seo.metaGooglebot ?? "";
        row.xRobotsTag = seo.xRobotsTag ?? "";
        row.ogType = seo.ogType ?? "";
        row.ogUrl = seo.ogUrl ?? "";
        row.ogImageWidthReal = seo.ogImageWidthReal ?? 0;
        row.ogImageHeightReal = seo.ogImageHeightReal ?? 0;
        if (seo.ogImageWidthReal && seo.ogImageHeightReal) {
          row.ogImageRatio = +(seo.ogImageWidthReal / seo.ogImageHeightReal).toFixed(2);
        }
        row.ogImageFileSize = seo.ogImageFileSize ?? 0;
        row.datePublishedTime = seo.datePublishedTime ?? "";
        row.dateModifiedTime = seo.dateModifiedTime ?? "";
        row.outlinks = seo.outlinks ?? [];
        row.responseHeaders = seo.responseHeaders;
        row.metaTags = seo.metaTags ?? [];
        row.scraper = seo.scraper ?? {};
      }
      seoVersion.value++;
    }
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
    pinnedSettings,
    seoVersion,
    crawlProgress,
    startCrawl,
    stopCrawl,
    clearResults,
    setResults,
    loadSession,
  };
}
