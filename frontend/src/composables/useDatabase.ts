import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
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
    // Reclaim per-session og:image disk space. Best-effort — if the FS op
    // fails (permissions, race with active crawler), the rows are already
    // gone so the orphaned dir is harmless and the user can wipe via Process.
    try {
      await invoke("delete_session_images", { sessionId });
    } catch (e) {
      console.warn("delete_session_images failed (orphan dir left behind):", e);
    }
  }

  async function clearAllSessions(): Promise<void> {
    // Snapshot ids BEFORE the SQL DELETE so we know which image dirs to nuke.
    const ids = (await listSessions()).map((s) => s.id);
    await serializeWrite(async () => {
      const d = await getDb();
      await d.execute("DELETE FROM crawl_results");
      await d.execute("DELETE FROM crawl_sessions");
    });
    for (const id of ids) {
      try { await invoke("delete_session_images", { sessionId: id }); } catch {}
    }
  }

  async function getSessionImageStats(sessionId: number): Promise<{ count: number; bytes: number }> {
    try {
      return await invoke<{ count: number; bytes: number }>("get_session_image_stats", { sessionId });
    } catch {
      return { count: 0, bytes: 0 };
    }
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
      const merged = mergeWithDefaults(obj);
      // Old crawls written under the new shape sometimes saved
      // crawling.mode='spider' even when the run was list-driven (the
      // mode field wasn't always pinned at start_crawl time). If the
      // snapshot has queued URLs, treat it as list — start_crawl's
      // list-mode branch is the only thing that consumes inputs.urls.
      if (merged.inputs.urls.length > 0 && merged.crawling.mode !== "list") {
        merged.crawling.mode = "list";
      }
      return merged;
    }
    // Old (pre-settings-unification) shape: bare CrawlConfig fields,
    // no `crawling` block at all. mergeWithDefaults fills in mode=spider
    // from the schema defaults — but if the saved crawl had a URL list,
    // that's the only way it could have been a list run, so infer.
    const inferredMode = Array.isArray(obj.urls) && (obj.urls as unknown[]).length > 0
      ? "list"
      : "spider";
    return mergeWithDefaults({ inputs: obj, crawling: { mode: inferredMode } });
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
    listSessions,
    deleteSession,
    clearAllSessions,
    loadSessionConfig,
    updateSessionConfig,
    getSessionStatus,
    getSessionImageStats,
  };
}
