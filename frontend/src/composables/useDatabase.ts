import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import type { CrawlResult } from "../types/crawl";
import type { SettingsValues } from "../settings/types";
import { mergeWithDefaults } from "../settings/defaults";
import { serializeWrite } from "../utils/dbWrite";

let dbPromise: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:fera.db").then(async (d) => {
      // WAL = concurrent reads alongside a writer + faster writes.
      // synchronous=NORMAL is durability-safe with WAL.
      // busy_timeout = 5000ms: rather than fail with SQLITE_BUSY when another
      // connection in the pool holds the writer lock, wait up to 5s for it.
      // (Belt; the JS-side serializeWrite mutex is the suspenders.)
      try {
        await d.execute("PRAGMA journal_mode=WAL");
        await d.execute("PRAGMA synchronous=NORMAL");
        await d.execute("PRAGMA busy_timeout=5000");
      } catch (e) {
        console.error("Failed to apply sqlite pragmas:", e);
      }
      return d;
    });
  }
  return dbPromise;
}

// ── Crawl-result writes ──────────────────────────────────────────────────
// Phase 1 of the extreme-performance refactor moved crawl_results writes
// into Rust: the sidecar's stdout NDJSON is parsed and written via sqlx
// directly. The frontend never inserts into crawl_results anymore — it just
// asks Rust to drain its buffer before any session-level read that needs
// to see in-flight rows. The Rust side handles batching (BATCH=200,
// FLUSH=1000ms) and DELETE-then-INSERT semantics for re-emits; the JS
// signature is preserved so existing callers (listSessions, loadSession,
// completeSession, …) need no changes.

export async function flushPendingInserts(): Promise<void> {
  try {
    await invoke("flush_crawl_writes");
  } catch (e) {
    // The flush command can only fail if the writer state is missing
    // (impossible after setup) or the underlying batch write errored.
    // Surface but don't throw — readers should still get whatever's
    // already on disk.
    console.error("flush_crawl_writes failed:", e);
  }
}

export interface CrawlSession {
  id: number;
  start_url: string;
  started_at: string;
  completed_at: string | null;
  result_count?: number;
  // SQL-computed list size from config_json. Avoids shipping the full
  // config blob just to read inputs.urls.length for the saved-crawls list.
  list_total?: number;
  config_json?: string;
}

export function useDatabase() {
  // config_json now stores the FULL SettingsValues snapshot (pinned config) so
  // resuming a saved crawl uses its original settings instead of whatever the
  // active profile happens to be now.
  async function createSession(startUrl: string, snapshot: SettingsValues): Promise<number> {
    return serializeWrite(async () => {
      const d = await getDb();
      const res = await d.execute(
        "INSERT INTO crawl_sessions (start_url, config_json) VALUES ($1, $2)",
        [startUrl, JSON.stringify(snapshot)]
      );
      return res.lastInsertId ?? 0;
    });
  }

  async function completeSession(sessionId: number): Promise<void> {
    await flushPendingInserts();
    await serializeWrite(async () => {
      const d = await getDb();
      await d.execute(
        "UPDATE crawl_sessions SET completed_at = CURRENT_TIMESTAMP WHERE id = $1",
        [sessionId]
      );
    });
  }

  async function listSessions(): Promise<CrawlSession[]> {
    // Buffered inserts must be visible in the COUNT(r.id) subquery — otherwise
    // an in-progress crawl shows a stale row count in the modal.
    await flushPendingInserts();
    return rawListSessions();
  }

  async function loadSessionResults(sessionId: number): Promise<CrawlResult[]> {
    await flushPendingInserts();
    const d = await getDb();
    // seo_json is the heaviest column (often 95%+ of payload by bytes) and is
    // loaded separately via loadSessionSeoBatch so the grid paints fast.
    const rows = await d.select<any[]>(
      `SELECT url, status, title, h1, h2, meta_description, canonical,
              internal_links, external_links, response_time, content_type,
              resource_type, size, error, word_count, meta_robots,
              is_indexable, is_noindex, is_nofollow,
              og_title, og_description, og_image, og_image_width, og_image_height,
              date_published, date_modified, redirect_url, server_header
       FROM crawl_results WHERE session_id = $1 ORDER BY id`,
      [sessionId]
    );
    return rows.map((r) => ({
      url: r.url,
      status: r.status ?? 0,
      title: r.title ?? "",
      h1: r.h1 ?? "",
      h2: r.h2 ?? "",
      metaDescription: r.meta_description ?? "",
      canonical: r.canonical ?? "",
      wordCount: r.word_count ?? 0,
      metaRobots: r.meta_robots ?? "",
      metaGooglebot: "",
      xRobotsTag: "",
      isIndexable: !!r.is_indexable,
      isNoindex: !!r.is_noindex,
      isNofollow: !!r.is_nofollow,
      ogTitle: r.og_title ?? "",
      ogDescription: r.og_description ?? "",
      ogType: "",
      ogUrl: "",
      ogImage: r.og_image ?? "",
      ogImageWidth: r.og_image_width ?? 0,
      ogImageHeight: r.og_image_height ?? 0,
      ogImageWidthReal: 0,
      ogImageHeightReal: 0,
      ogImageRatio: (r.og_image_width && r.og_image_height)
        ? +(r.og_image_width / r.og_image_height).toFixed(2)
        : 0,
      ogImageFileSize: 0,
      datePublished: r.date_published ?? "",
      dateModified: r.date_modified ?? "",
      datePublishedTime: "",
      dateModifiedTime: "",
      internalLinks: r.internal_links ?? 0,
      externalLinks: r.external_links ?? 0,
      outlinks: [],
      responseTime: r.response_time ?? 0,
      contentType: r.content_type ?? "",
      resourceType: r.resource_type ?? "Other",
      size: r.size ?? 0,
      error: r.error ?? undefined,
      responseHeaders: undefined,
      redirectUrl: r.redirect_url || undefined,
      serverHeader: r.server_header || undefined,
      metaTags: [],
      scraper: {},
    }));
  }

  // Returns seo_json strings for rows in the same id order as loadSessionResults,
  // so callers can merge by index. Pages via LIMIT/OFFSET to keep IPC payloads
  // bounded; an 8.5k-row × 20 KB-avg seo_json column is ~160 MB if loaded as
  // one IPC blob and would re-block the UI for ~12s.
  async function loadSessionSeoBatch(sessionId: number, offset: number, limit: number): Promise<string[]> {
    const d = await getDb();
    const rows = await d.select<{ seo_json: string | null }[]>(
      `SELECT seo_json FROM crawl_results WHERE session_id = $1 ORDER BY id LIMIT $2 OFFSET $3`,
      [sessionId, limit, offset]
    );
    return rows.map((r) => r.seo_json || "{}");
  }

  async function rawListSessions(): Promise<CrawlSession[]> {
    const d = await getDb();
    // Pre-compute list_total in SQL via SQLite's JSON1 extension instead of
    // shipping the full config_json blob (can be MB-sized for big list crawls)
    // and JSON.parsing it 4x per row in the template. Fall back to the legacy
    // top-level `$.urls` when `$.inputs.urls` is missing.
    return d.select<CrawlSession[]>(
      `SELECT s.id, s.start_url, s.started_at, s.completed_at,
              COALESCE(
                json_array_length(json_extract(s.config_json, '$.inputs.urls')),
                json_array_length(json_extract(s.config_json, '$.urls')),
                0
              ) AS list_total,
              COUNT(r.id) as result_count
       FROM crawl_sessions s
       LEFT JOIN crawl_results r ON r.session_id = s.id
       GROUP BY s.id
       ORDER BY s.started_at DESC
       LIMIT 50`
    );
  }

  async function deleteSession(sessionId: number): Promise<void> {
    await serializeWrite(async () => {
      const d = await getDb();
      await d.execute("DELETE FROM crawl_results WHERE session_id = $1", [sessionId]);
      await d.execute("DELETE FROM crawl_sessions WHERE id = $1", [sessionId]);
    });
  }

  async function clearAllSessions(): Promise<void> {
    await serializeWrite(async () => {
      const d = await getDb();
      await d.execute("DELETE FROM crawl_results");
      await d.execute("DELETE FROM crawl_sessions");
    });
  }

  async function closeOrphanedSessions(): Promise<void> {
    await serializeWrite(async () => {
      const d = await getDb();
      await d.execute(
        "UPDATE crawl_sessions SET completed_at = CURRENT_TIMESTAMP WHERE completed_at IS NULL"
      );
    });
  }

  async function getLatestSession(): Promise<CrawlSession | null> {
    await flushPendingInserts();
    const d = await getDb();
    const rows = await d.select<CrawlSession[]>(
      `SELECT s.id, s.start_url, s.started_at, s.completed_at,
              COUNT(r.id) as result_count
       FROM crawl_sessions s
       LEFT JOIN crawl_results r ON r.session_id = s.id
       GROUP BY s.id
       ORDER BY s.started_at DESC
       LIMIT 1`
    );
    return rows.length > 0 ? rows[0] : null;
  }

  // Latest crawl that has rows AND wasn't marked complete. Used at boot /
  // HMR to rehydrate state — the stopped flag, pinned snapshot, and
  // currentSessionId would otherwise be lost when the useCrawl module
  // re-executes. Returns null if there's nothing to resume.
  async function getLatestIncompleteSession(): Promise<CrawlSession | null> {
    await flushPendingInserts();
    const d = await getDb();
    const rows = await d.select<CrawlSession[]>(
      `SELECT s.id, s.start_url, s.started_at, s.completed_at,
              COUNT(r.id) as result_count
       FROM crawl_sessions s
       LEFT JOIN crawl_results r ON r.session_id = s.id
       WHERE s.completed_at IS NULL
       GROUP BY s.id
       HAVING result_count > 0
       ORDER BY s.started_at DESC
       LIMIT 1`
    );
    return rows.length > 0 ? rows[0] : null;
  }

  // Reads the pinned settings snapshot for a session. Old rows persisted only
  // the CrawlConfig slice (urls, customHeaders, scraperRules, recrawlQueue);
  // sniff that shape and migrate forward by stuffing it into the inputs bucket
  // and merging schema defaults under the rest.
  async function loadSessionConfig(sessionId: number): Promise<SettingsValues | null> {
    const d = await getDb();
    const rows = await d.select<{ config_json: string }[]>(
      "SELECT config_json FROM crawl_sessions WHERE id = $1",
      [sessionId]
    );
    if (!rows.length || !rows[0].config_json) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rows[0].config_json);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    // New shape has top-level schema buckets. Old shape has CrawlConfig fields.
    const isNewShape = "crawling" in obj || "performance" in obj || "stealth" in obj;
    if (isNewShape) {
      return mergeWithDefaults(obj);
    }
    return mergeWithDefaults({ inputs: obj });
  }

  async function getSessionStatus(sessionId: number): Promise<{ completed_at: string | null }> {
    const d = await getDb();
    const rows = await d.select<{ completed_at: string | null }[]>(
      "SELECT completed_at FROM crawl_sessions WHERE id = $1",
      [sessionId]
    );
    return rows.length > 0 ? rows[0] : { completed_at: null };
  }

  async function updateSessionConfig(sessionId: number, snapshot: SettingsValues): Promise<void> {
    await flushPendingInserts();
    await serializeWrite(async () => {
      const d = await getDb();
      await d.execute(
        "UPDATE crawl_sessions SET config_json = $1 WHERE id = $2",
        [JSON.stringify(snapshot), sessionId]
      );
    });
  }

  return {
    createSession,
    completeSession,
    loadSessionResults,
    loadSessionSeoBatch,
    listSessions,
    deleteSession,
    clearAllSessions,
    closeOrphanedSessions,
    getLatestSession,
    getLatestIncompleteSession,
    loadSessionConfig,
    updateSessionConfig,
    getSessionStatus,
  };
}
