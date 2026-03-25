import Database from "@tauri-apps/plugin-sql";
import type { CrawlResult } from "../types/crawl";

let dbPromise: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:fera.db");
  }
  return dbPromise;
}

export interface CrawlSession {
  id: number;
  start_url: string;
  started_at: string;
  completed_at: string | null;
  result_count?: number;
}

export function useDatabase() {
  async function createSession(startUrl: string): Promise<number> {
    const d = await getDb();
    const res = await d.execute(
      "INSERT INTO crawl_sessions (start_url) VALUES ($1)",
      [startUrl]
    );
    return res.lastInsertId ?? 0;
  }

  async function completeSession(sessionId: number): Promise<void> {
    const d = await getDb();
    await d.execute(
      "UPDATE crawl_sessions SET completed_at = CURRENT_TIMESTAMP WHERE id = $1",
      [sessionId]
    );
  }

  async function insertResult(sessionId: number, result: CrawlResult): Promise<void> {
    const d = await getDb();
    await d.execute(
      `INSERT INTO crawl_results
        (session_id, url, status, title, h1, meta_description, canonical,
         internal_links, external_links, response_time, content_type,
         resource_type, size, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        sessionId,
        result.url,
        result.status,
        result.title,
        result.h1,
        result.metaDescription,
        result.canonical,
        result.internalLinks,
        result.externalLinks,
        result.responseTime,
        result.contentType,
        result.resourceType,
        result.size,
        result.error ?? null,
      ]
    );
  }

  async function loadSessionResults(sessionId: number): Promise<CrawlResult[]> {
    const d = await getDb();
    const rows = await d.select<any[]>(
      `SELECT url, status, title, h1, meta_description, canonical,
              internal_links, external_links, response_time, content_type,
              resource_type, size, error
       FROM crawl_results WHERE session_id = $1 ORDER BY id`,
      [sessionId]
    );
    return rows.map((r) => ({
      url: r.url,
      status: r.status ?? 0,
      title: r.title ?? "",
      h1: r.h1 ?? "",
      metaDescription: r.meta_description ?? "",
      canonical: r.canonical ?? "",
      internalLinks: r.internal_links ?? 0,
      externalLinks: r.external_links ?? 0,
      responseTime: r.response_time ?? 0,
      contentType: r.content_type ?? "",
      resourceType: r.resource_type ?? "Other",
      size: r.size ?? 0,
      error: r.error ?? undefined,
    }));
  }

  async function listSessions(): Promise<CrawlSession[]> {
    const d = await getDb();
    return d.select<CrawlSession[]>(
      `SELECT s.id, s.start_url, s.started_at, s.completed_at,
              COUNT(r.id) as result_count
       FROM crawl_sessions s
       LEFT JOIN crawl_results r ON r.session_id = s.id
       GROUP BY s.id
       ORDER BY s.started_at DESC
       LIMIT 50`
    );
  }

  async function deleteSession(sessionId: number): Promise<void> {
    const d = await getDb();
    await d.execute("DELETE FROM crawl_results WHERE session_id = $1", [sessionId]);
    await d.execute("DELETE FROM crawl_sessions WHERE id = $1", [sessionId]);
  }

  async function clearAllSessions(): Promise<void> {
    const d = await getDb();
    await d.execute("DELETE FROM crawl_results");
    await d.execute("DELETE FROM crawl_sessions");
  }

  /**
   * Called on app startup. Marks any sessions with completed_at = NULL
   * as abandoned so they don't look like active crawls.
   */
  async function closeOrphanedSessions(): Promise<void> {
    const d = await getDb();
    await d.execute(
      "UPDATE crawl_sessions SET completed_at = CURRENT_TIMESTAMP WHERE completed_at IS NULL"
    );
  }

  /**
   * Returns the most recent session (if any) so the app can
   * auto-load the last crawl on startup.
   */
  async function getLatestSession(): Promise<CrawlSession | null> {
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

  return {
    createSession,
    completeSession,
    insertResult,
    loadSessionResults,
    listSessions,
    deleteSession,
    clearAllSessions,
    closeOrphanedSessions,
    getLatestSession,
  };
}
