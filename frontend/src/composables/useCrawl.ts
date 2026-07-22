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
// True when the user explicitly hit STOP for the in-flight crawl. Read by the
// crawl-complete handler to tell a user interruption (resumable) apart from a
// natural queue-drained completion. Plain flag (not reactive) — set/reset
// synchronously around the crawl lifecycle.
let userStopped = false;
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
  } = useDatabase();

  // Wire the global crawl-progress listener once. Idempotent — subsequent
  // useCrawl() callers no-op.
  void ensureProgressListener();

  // No auto-rehydrate. Boot starts blank; the user picks a saved crawl
  // explicitly via File → Saved Crawls if they want to resume one. Auto-
  // loading the last incomplete session was confusing — pages and stats
  // appeared without any URL in the input field, with no banner explaining
  // where they came from.

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
    userStopped = false;
    // Resume keeps the loaded count visible. Resetting on resume flashed
    // PAGES CRAWLED to 0 and then to the new-rows-only count (e.g. 10
    // instead of 14,691 already-on-disk). Fresh starts wipe to 0 so the
    // hero card doesn't carry over the prior crawl's numbers.
    if (!resume) resetCrawlProgress();

    // Create a DB session (or reuse current for resume). Guarded: these awaits
    // run AFTER crawling.value=true but BEFORE the complete listener is wired,
    // so a throw here would otherwise strand the UI in a "crawling" state with
    // no sidecar and no listener (recoverable only via STOP).
    let sessionId: number;
    try {
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
    } catch (e) {
      crawling.value = false;
      cleanup();
      throw e; // let handleStart surface it instead of silently hanging
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
        // Informational only now (hadFailures). Normal 4xx/5xx/timeouts no
        // longer mark a crawl "stopped" — see decideCompletion.
        errorCount = h.errors + h.status4xx + h.status5xx + h.statusOther;
      } catch (e) {
        console.error("aggregate_health on complete failed:", e);
      }
      // Parked/blocked URLs are the real resumable signal (vs. plain HTTP
      // errors). If any remain, the crawl is "stopped" so the user can resume
      // to retry them; the resume path re-seeds them via get_retryable_urls.
      let retryableCount = 0;
      try {
        const retryable = await invoke<string[]>("get_retryable_urls", { sessionId });
        retryableCount = retryable.length;
      } catch (e) {
        console.error("get_retryable_urls on complete failed:", e);
      }
      const decision = decideCompletion({
        rowCount,
        errorCount,
        listTotal: inputs.urls.length,
        interrupted: userStopped,
        retryableCount,
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

    // On resume, fetch the set of already-crawled URLs from Rust so the
    // sidecar's --exclude-urls argument skips them. Block-stubs are
    // intentionally NOT excluded by the Rust query — the host may have
    // come back online and we want a real fetch. Recrawl targets and
    // explicit URL lists override the skip set.
    let excludeUrls: Set<string> | undefined;
    if (resume) {
      try {
        const skippable = await invoke<string[]>("get_skippable_urls", { sessionId });
        const skipSet = new Set(skippable);
        if (opts.replaceUrls) {
          for (const u of opts.replaceUrls) skipSet.delete(u);
        }
        if (opts.urls) {
          for (const u of opts.urls) skipSet.delete(u);
        }
        excludeUrls = skipSet;
      } catch (e) {
        console.error("get_skippable_urls failed (resume will refetch already-crawled rows):", e);
      }
    }

    // On resume, recover everything the prior run discovered but didn't finish,
    // re-seeded as explicit spider seeds (spider mode only; list/recrawl callers
    // manage their own URL set):
    //   - frontier  — discovered-but-never-crawled URLs (the deep frontier).
    //     These aren't in the sitemap and can't be re-discovered (their linking
    //     pages are already crawled), so without this they'd be lost on stop.
    //   - retryable — block-detector-parked placeholder rows, disjoint from the
    //     frontier (those are already in crawl_results).
    let seedUrls = opts.urls;
    const effectiveMode = opts.mode ?? s.crawling.mode;
    if (resume && effectiveMode === "spider") {
      const [frontier, retryable] = await Promise.all([
        invoke<string[]>("get_frontier_urls", { sessionId }).catch((e) => {
          console.error("get_frontier_urls failed (frontier won't be re-seeded):", e);
          return [] as string[];
        }),
        invoke<string[]>("get_retryable_urls", { sessionId }).catch((e) => {
          console.error("get_retryable_urls failed (parked URLs won't be re-seeded):", e);
          return [] as string[];
        }),
      ]);
      const extra = [...new Set([...frontier, ...retryable])];
      if (extra.length > 0) {
        seedUrls = [...(opts.urls ?? []), ...extra];
        console.info(`resume: re-seeding ${frontier.length} frontier + ${retryable.length} parked URLs`);
      }
    }

    try {
      await invoke(
        "start_crawl",
        buildStartCrawlPayload(url, s, {
          mode: opts.mode,
          urls: seedUrls,
          maxRequests: opts.maxRequests,
          excludeUrls,
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
    // Mark BEFORE the kill so a crawl-complete racing in from the dying sidecar
    // is correctly classified as a user interruption (resumable), not a natural
    // completion.
    userStopped = true;
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
    // If a crawl is in flight, stop the sidecar FIRST. Clearing must never
    // leave an orphaned sidecar writing rows into a session we're abandoning
    // (which also let a stale crawl-complete fire against the old sessionId).
    if (crawling.value) {
      userStopped = true;
      try {
        await invoke("stop_crawl");
      } catch (e) {
        console.error("stop_crawl on clear failed:", e);
      }
    }
    if (currentSessionId.value) {
      try {
        await completeSession(currentSessionId.value);
      } catch (e) {
        console.error("DB session complete on clear failed:", e);
      }
    }
    crawling.value = false;
    currentSessionId.value = null;
    stopped.value = false;
    pinnedSettings.value = null;
    resetCrawlProgress();
    // Drop the crawl-complete listener — its closure captured the now-cleared
    // sessionId, so leaving it live would run completion logic on a dead session.
    cleanup();
    useDebug().clearLogs();
  }

  async function loadSession(sessionId: number): Promise<SettingsValues | null> {
    // Drop any crawl-complete listener still bound to a prior in-flight crawl —
    // otherwise its closure could run completion logic against this newly
    // opened session's id after we switch currentSessionId below.
    cleanup();
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

  // Finalize a crawl we adopted on boot (see adoptRunningCrawl). Mirrors the
  // completion decision in startCrawl's crawl-complete closure, minus the
  // per-call context we don't have for an adopted crawl (recrawl-queue drain,
  // the live settings object). interrupted is always false here: if the user
  // hits STOP, stopCrawl() runs its own path and cleanup() drops this listener
  // before the sidecar's crawl-complete lands.
  async function finalizeAdopted(sessionId: number) {
    crawling.value = false;
    let rowCount = crawlProgress.value.rowCount;
    let errorCount = crawlProgress.value.errorCount;
    try {
      const h = await invoke<HealthSnapshot>("aggregate_health", { sessionId });
      rowCount = h.total;
      errorCount = h.errors + h.status4xx + h.status5xx + h.statusOther;
    } catch (e) {
      console.error("aggregate_health on adopt-complete failed:", e);
    }
    let retryableCount = 0;
    try {
      retryableCount = (await invoke<string[]>("get_retryable_urls", { sessionId })).length;
    } catch (e) {
      console.error("get_retryable_urls on adopt-complete failed:", e);
    }
    const decision = decideCompletion({
      rowCount,
      errorCount,
      listTotal: pinnedSettings.value?.inputs.urls.length ?? 0,
      interrupted: false,
      retryableCount,
    });
    try {
      if (decision.isStopped) stopped.value = true;
      else await completeSession(sessionId);
    } catch (e) {
      console.error("DB session complete on adopt failed:", e);
    }
    cleanup();
  }

  // Re-adopt a crawl that outlived a webview reload. The Rust backend + sidecar
  // survive a frontend reload; Vue state doesn't. Without this, the reloaded UI
  // owns no session yet still receives the live crawl-progress firehose (a
  // global listener), painting phantom counts with an empty URL and all-zero
  // health cards. Returns the session's start URL so the caller can refill the
  // URL input. No-op if we already own a session or nothing is running.
  async function adoptRunningCrawl(): Promise<{ startUrl: string } | null> {
    if (currentSessionId.value != null) return null;
    let info: { running: boolean; sessionId: number };
    try {
      info = await invoke<{ running: boolean; sessionId: number }>("active_crawl");
    } catch (e) {
      console.error("active_crawl failed:", e);
      return null;
    }
    if (!info.running || info.sessionId <= 0) return null;

    const sessionId = info.sessionId;
    currentSessionId.value = sessionId;
    pinnedSettings.value = await loadSessionConfig(sessionId);

    // Backfill live counts so cards aren't 0 until the next progress tick.
    try {
      const h = await invoke<HealthSnapshot>("aggregate_health", { sessionId });
      crawlProgress.value = {
        rowCount: h.total,
        errorCount: h.errors + h.status4xx + h.status5xx + h.statusOther,
        lastUrl: "",
        latestStatuses: [],
      };
    } catch (e) {
      console.error("aggregate_health on adopt failed:", e);
    }

    crawling.value = true;
    stopped.value = false;
    userStopped = false;

    // The sidecar's natural termination still emits crawl-complete; wire a
    // listener so the adopted crawl finalizes instead of hanging in "crawling".
    cleanup();
    unlistenComplete = await listen<void>("crawl-complete", () => {
      void finalizeAdopted(sessionId);
    });

    // Close the race where the crawl finished between active_crawl and the
    // listener registration above (its crawl-complete would be missed, leaving
    // the UI stuck in "crawling"). finalizeAdopted is idempotent — a completed
    // session's UPDATE and stopped flag are harmless to re-apply.
    try {
      const still = await invoke<{ running: boolean }>("active_crawl");
      if (!still.running) void finalizeAdopted(sessionId);
    } catch (e) {
      console.error("active_crawl recheck failed:", e);
    }

    const status = await getSessionStatus(sessionId);
    return { startUrl: status.start_url };
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
    adoptRunningCrawl,
  };
}
