import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDatabase } from "./useDatabase";
import { useSettings } from "./useSettings";
import { useDebug } from "./useDebug";
import type { SettingsValues } from "../settings/types";
import { decideCompletion } from "../utils/completionStatus";
import { buildStartCrawlPayload } from "../utils/startCrawlPayload";

// Phase-6 cleanup: there is no longer an in-memory results array. The
// data grid pages over query_results, the health screen pages over
// aggregate_health, exports/saves stream from query_all_results. Counts
// (rowCount/errorCount) come from the live `crawl-progress` aggregate
// during a crawl and from aggregate_health when opening a saved session.

const crawling = ref(false);
const stopped = ref(false);
const currentSessionId = ref<number | null>(null);

/** Live aggregate from the Rust `crawl-progress` event (Phase 3) plus the
 *  saved-session backfill set by loadSession. The data grid bumps a
 *  refresh key on every change; the health screen reads it directly. */
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
let unlistenComplete: (() => void) | null = null;

interface HealthSnapshot {
  total: number;
  errors: number;
  status4xx: number;
  status5xx: number;
  statusOther: number;
}

export function useCrawl() {
  const {
    createSession,
    completeSession,
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

    // Kill any sign-in browser first — can't share the profile directory
    try {
      await invoke("close_browser");
    } catch {}
    // Give Chromium a moment to fully release the profile lock
    await new Promise((r) => setTimeout(r, 500));

    cleanup();

    // On resume, the sidecar's excludeUrls argument is built server-side
    // from already-crawled rows; we no longer ship that set from JS because
    // the JS side doesn't track per-url state anymore. Recrawl targets and
    // explicit URL lists are still exempt — the caller passes them in
    // `replaceUrls` / `opts.urls`.
    if (!resume) {
      // Fresh crawl — recrawl queue from a prior crawl no longer applies.
      if (inputs.recrawlQueue.length > 0) {
        inputs.recrawlQueue = [];
      }
    }
    crawling.value = true;
    stopped.value = false;
    resetCrawlProgress();

    // Create a DB session (or reuse current for resume).
    let sessionId: number;
    if (resume && currentSessionId.value) {
      sessionId = currentSessionId.value;
      await updateSessionConfig(sessionId, s);
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

    unlistenComplete = await listen<void>("crawl-complete", async () => {
      crawling.value = false;

      // Decide BEFORE writing to DB. The decision is now driven by the
      // live aggregate (rowCount/errorCount) plus a fresh aggregate_health
      // for failure-status counts — there's no in-memory rows to scan.
      let errorCount = crawlProgress.value.errorCount;
      let rowCount = crawlProgress.value.rowCount;
      try {
        const h = await invoke<HealthSnapshot>("aggregate_health", { sessionId });
        rowCount = h.total;
        // Mirror legacy semantics: error-string rows + 4xx + 5xx + non-HTTP
        // statuses (0/600+) all count as failures for completion purposes.
        errorCount = h.errors + h.status4xx + h.status5xx + h.statusOther;
      } catch (e) {
        console.error("aggregate_health on complete failed:", e);
      }
      const decision = decideCompletion({
        rowCount,
        errorCount,
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

      // Recrawl queue draining: the URLs that came back successfully should
      // leave the queue. We can't tell row-by-row anymore (no in-memory rows),
      // so we ask Rust which URLs in the queue still don't have a clean row.
      if (opts.replaceUrls && opts.replaceUrls.size > 0 && inputs.recrawlQueue.length > 0) {
        try {
          const stillBroken = await invoke<any[]>("query_results", {
            sessionId,
            page: 0,
            limit: inputs.recrawlQueue.length,
            filter: {
              urlIn: inputs.recrawlQueue.filter((u) => opts.replaceUrls!.has(u)),
              issuesOnly: true,
            },
            sort: null,
          });
          const stillBrokenSet = new Set(stillBroken.map((r) => r.url as string));
          inputs.recrawlQueue = inputs.recrawlQueue.filter(
            (u) => !opts.replaceUrls!.has(u) || stillBrokenSet.has(u),
          );
        } catch (e) {
          console.error("recrawl queue drain via query_results failed:", e);
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
          // No excludeUrls: the JS side can't enumerate already-crawled
          // rows without holding them in memory. Resume just re-runs the
          // sidecar; if a row already exists, the writer's DELETE-then-INSERT
          // contract overwrites it cleanly.
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
    currentSessionId.value = null;
    stopped.value = false;
    pinnedSettings.value = null;
    resetCrawlProgress();
    useDebug().clearLogs();
  }

  async function loadSession(sessionId: number): Promise<SettingsValues | null> {
    useDebug().clearLogs();
    currentSessionId.value = sessionId;
    const snapshot = await loadSessionConfig(sessionId);
    pinnedSettings.value = snapshot;

    // Backfill the live progress ref so cards/grid don't show 0 immediately
    // after open. aggregate_health gives us totals + error mix in one round
    // trip — same query the health screen uses.
    try {
      const h = await invoke<HealthSnapshot>("aggregate_health", { sessionId });
      crawlProgress.value = {
        rowCount: h.total,
        errorCount: h.errors + h.status4xx + h.status5xx + h.statusOther,
        lastUrl: "",
        latestStatuses: [],
      };
    } catch (e) {
      console.error("aggregate_health on loadSession failed:", e);
      resetCrawlProgress();
    }

    const status = await getSessionStatus(sessionId);
    const listTotal = snapshot?.inputs.urls.length ?? 0;
    const isPartial = listTotal > 0
      ? crawlProgress.value.rowCount < listTotal
      : status.completed_at == null && crawlProgress.value.rowCount > 0;
    stopped.value = isPartial;

    return snapshot;
  }

  function cleanup() {
    if (unlistenComplete) {
      unlistenComplete();
      unlistenComplete = null;
    }
  }

  return {
    crawling,
    stopped,
    currentSessionId,
    pinnedSettings,
    crawlProgress,
    startCrawl,
    stopCrawl,
    clearResults,
    loadSession,
  };
}
