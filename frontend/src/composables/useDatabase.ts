import Database from "@tauri-apps/plugin-sql";
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

// ── Batched insert buffer ────────────────────────────────────────────────
// 32K-URL crawls = 32K individual INSERTs in their own transactions today.
// Buffer rows and flush as a single transaction every BATCH_SIZE rows or
// FLUSH_MS, whichever comes first. Callers MUST await flushPendingInserts()
// before any session-level operation that depends on rows being persisted
// (completeSession, updateSessionConfig, loadSessionResults of an active
// session, …) — otherwise rows still in the buffer aren't visible.

interface PendingInsert {
  sessionId: number;
  result: CrawlResult;
}

const insertBuffer: PendingInsert[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight: Promise<void> | null = null;
const FLUSH_MS = 1000;
const BATCH_SIZE = 200;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPendingInserts();
  }, FLUSH_MS);
}

async function doFlush(): Promise<void> {
  if (insertBuffer.length === 0) return;
  const batch = insertBuffer.splice(0);
  await serializeWrite(() => doFlushInner(batch));
}

// 30 columns per row in the values clause.
const COLS_PER_ROW = 30;

function seoJsonFor(result: CrawlResult): string {
  return JSON.stringify({
    metaGooglebot: result.metaGooglebot || "",
    xRobotsTag: result.xRobotsTag || "",
    ogType: result.ogType || "",
    ogUrl: result.ogUrl || "",
    datePublishedTime: result.datePublishedTime || "",
    dateModifiedTime: result.dateModifiedTime || "",
    outlinks: result.outlinks || [],
    metaTags: result.metaTags || [],
    responseHeaders: result.responseHeaders || {},
    ogImageWidthReal: result.ogImageWidthReal || 0,
    ogImageHeightReal: result.ogImageHeightReal || 0,
    ogImageFileSize: result.ogImageFileSize || 0,
    scraper: result.scraper || {},
  });
}

function rowParams(sessionId: number, r: CrawlResult): unknown[] {
  return [
    sessionId,
    r.url,
    r.status,
    r.title,
    r.h1,
    r.h2,
    r.metaDescription,
    r.canonical,
    r.internalLinks,
    r.externalLinks,
    r.responseTime,
    r.contentType,
    r.resourceType,
    r.size,
    r.error ?? null,
    r.wordCount,
    r.metaRobots,
    r.isIndexable ? 1 : 0,
    r.isNoindex ? 1 : 0,
    r.isNofollow ? 1 : 0,
    r.ogTitle,
    r.ogDescription,
    r.ogImage,
    r.ogImageWidth,
    r.ogImageHeight,
    r.datePublished,
    r.dateModified,
    r.redirectUrl ?? "",
    r.serverHeader ?? "",
    seoJsonFor(r),
  ];
}

// Tauri's sqlx-sqlite plugin uses a multi-connection pool, so explicit
// BEGIN/COMMIT from JS are connection-roulette and can leak (BEGIN on conn
// A, INSERT on conn B → COMMIT lands on a third conn → conn A returned to
// the pool with txn open → next caller errors with "cannot start a
// transaction within a transaction"). Solution: build ONE multi-row INSERT
// statement per batch — atomic at the statement level, single connection,
// no explicit transaction needed. DELETE for re-crawled URLs runs as a
// separate single statement; the tiny window between DELETE and INSERT is
// acceptable (only readers concurrent with the flush could see fewer rows
// momentarily, and grid display is debounced anyway).
async function doFlushInner(batch: PendingInsert[]): Promise<void> {
  if (batch.length === 0) return;
  const d = await getDb();

  // Group by sessionId so each DELETE picks up all replaced URLs in one shot.
  const bySession = new Map<number, CrawlResult[]>();
  for (const { sessionId, result } of batch) {
    const arr = bySession.get(sessionId);
    if (arr) arr.push(result);
    else bySession.set(sessionId, [result]);
  }

  // DELETE first so re-crawls / parked-stub replacements take effect.
  for (const [sessionId, results] of bySession) {
    if (results.length === 0) continue;
    const placeholders = results.map((_, i) => `$${i + 2}`).join(",");
    await d.execute(
      `DELETE FROM crawl_results WHERE session_id = $1 AND url IN (${placeholders})`,
      [sessionId, ...results.map((r) => r.url)],
    );
  }

  // Single multi-row INSERT for the entire batch.
  const valuesClauses: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const { sessionId, result } of batch) {
    const placeholders = Array.from({ length: COLS_PER_ROW }, () => `$${p++}`).join(",");
    valuesClauses.push(`(${placeholders})`);
    params.push(...rowParams(sessionId, result));
  }
  await d.execute(
    `INSERT INTO crawl_results
      (session_id, url, status, title, h1, h2, meta_description, canonical,
       internal_links, external_links, response_time, content_type,
       resource_type, size, error, word_count, meta_robots,
       is_indexable, is_noindex, is_nofollow,
       og_title, og_description, og_image, og_image_width, og_image_height,
       date_published, date_modified, redirect_url, server_header, seo_json)
     VALUES ${valuesClauses.join(",")}`,
    params,
  );
}

export async function flushPendingInserts(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // Serialize concurrent flushers — only one transaction at a time.
  while (flushInFlight) await flushInFlight;
  if (insertBuffer.length === 0) return;
  flushInFlight = doFlush().finally(() => { flushInFlight = null; });
  await flushInFlight;
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

  // Pushes onto the batched-insert buffer; the actual DB write happens in
  // a transaction at flush time. Errors surface from flushPendingInserts.
  function insertResult(sessionId: number, result: CrawlResult): void {
    insertBuffer.push({ sessionId, result });
    if (insertBuffer.length >= BATCH_SIZE) {
      void flushPendingInserts();
    } else {
      scheduleFlush();
    }
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
    insertResult,
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
