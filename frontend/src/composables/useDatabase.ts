import Database from "@tauri-apps/plugin-sql";
import type { CrawlResult, CrawlConfig } from "../types/crawl";

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
  config_json?: string;
}

export function useDatabase() {
  async function createSession(startUrl: string, config?: CrawlConfig): Promise<number> {
    const d = await getDb();
    const configJson = config ? JSON.stringify(config) : "{}";
    const res = await d.execute(
      "INSERT INTO crawl_sessions (start_url, config_json) VALUES ($1, $2)",
      [startUrl, configJson]
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

    // Pack overflow fields into seo_json
    const seoJson = JSON.stringify({
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

    // Remove any existing row for this URL in this session (recrawl dedup)
    await d.execute(
      "DELETE FROM crawl_results WHERE session_id = $1 AND url = $2",
      [sessionId, result.url]
    );

    await d.execute(
      `INSERT INTO crawl_results
        (session_id, url, status, title, h1, h2, meta_description, canonical,
         internal_links, external_links, response_time, content_type,
         resource_type, size, error, word_count, meta_robots,
         is_indexable, is_noindex, is_nofollow,
         og_title, og_description, og_image, og_image_width, og_image_height,
         date_published, date_modified, redirect_url, server_header, seo_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,
      [
        sessionId,
        result.url,
        result.status,
        result.title,
        result.h1,
        result.h2,
        result.metaDescription,
        result.canonical,
        result.internalLinks,
        result.externalLinks,
        result.responseTime,
        result.contentType,
        result.resourceType,
        result.size,
        result.error ?? null,
        result.wordCount,
        result.metaRobots,
        result.isIndexable ? 1 : 0,
        result.isNoindex ? 1 : 0,
        result.isNofollow ? 1 : 0,
        result.ogTitle,
        result.ogDescription,
        result.ogImage,
        result.ogImageWidth,
        result.ogImageHeight,
        result.datePublished,
        result.dateModified,
        result.redirectUrl ?? "",
        result.serverHeader ?? "",
        seoJson,
      ]
    );
  }

  async function loadSessionResults(sessionId: number): Promise<CrawlResult[]> {
    const d = await getDb();
    const rows = await d.select<any[]>(
      `SELECT url, status, title, h1, h2, meta_description, canonical,
              internal_links, external_links, response_time, content_type,
              resource_type, size, error, word_count, meta_robots,
              is_indexable, is_noindex, is_nofollow,
              og_title, og_description, og_image, og_image_width, og_image_height,
              date_published, date_modified, redirect_url, server_header, seo_json
       FROM crawl_results WHERE session_id = $1 ORDER BY id`,
      [sessionId]
    );
    return rows.map((r) => {
      let seo: any = {};
      try { seo = JSON.parse(r.seo_json || "{}"); } catch {}

      return {
        url: r.url,
        status: r.status ?? 0,
        title: r.title ?? "",
        h1: r.h1 ?? "",
        h2: r.h2 ?? "",
        metaDescription: r.meta_description ?? "",
        canonical: r.canonical ?? "",
        wordCount: r.word_count ?? 0,
        metaRobots: r.meta_robots ?? "",
        metaGooglebot: seo.metaGooglebot ?? "",
        xRobotsTag: seo.xRobotsTag ?? "",
        isIndexable: !!r.is_indexable,
        isNoindex: !!r.is_noindex,
        isNofollow: !!r.is_nofollow,
        ogTitle: r.og_title ?? "",
        ogDescription: r.og_description ?? "",
        ogType: seo.ogType ?? "",
        ogUrl: seo.ogUrl ?? "",
        ogImage: r.og_image ?? "",
        ogImageWidth: r.og_image_width ?? 0,
        ogImageHeight: r.og_image_height ?? 0,
        ogImageWidthReal: seo.ogImageWidthReal ?? 0,
        ogImageHeightReal: seo.ogImageHeightReal ?? 0,
        ogImageRatio: (seo.ogImageWidthReal && seo.ogImageHeightReal)
          ? +(seo.ogImageWidthReal / seo.ogImageHeightReal).toFixed(2)
          : (r.og_image_width && r.og_image_height) ? +(r.og_image_width / r.og_image_height).toFixed(2) : 0,
        ogImageFileSize: seo.ogImageFileSize ?? 0,
        datePublished: r.date_published ?? "",
        dateModified: r.date_modified ?? "",
        datePublishedTime: seo.datePublishedTime ?? "",
        dateModifiedTime: seo.dateModifiedTime ?? "",
        internalLinks: r.internal_links ?? 0,
        externalLinks: r.external_links ?? 0,
        outlinks: seo.outlinks ?? [],
        responseTime: r.response_time ?? 0,
        contentType: r.content_type ?? "",
        resourceType: r.resource_type ?? "Other",
        size: r.size ?? 0,
        error: r.error ?? undefined,
        responseHeaders: seo.responseHeaders ?? undefined,
        redirectUrl: r.redirect_url || undefined,
        serverHeader: r.server_header || undefined,
        metaTags: seo.metaTags ?? [],
        scraper: seo.scraper ?? {},
      };
    });
  }

  async function listSessions(): Promise<CrawlSession[]> {
    const d = await getDb();
    return d.select<CrawlSession[]>(
      `SELECT s.id, s.start_url, s.started_at, s.completed_at, s.config_json,
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

  async function closeOrphanedSessions(): Promise<void> {
    const d = await getDb();
    await d.execute(
      "UPDATE crawl_sessions SET completed_at = CURRENT_TIMESTAMP WHERE completed_at IS NULL"
    );
  }

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

  async function loadSessionConfig(sessionId: number): Promise<CrawlConfig | null> {
    const d = await getDb();
    const rows = await d.select<{ config_json: string }[]>(
      "SELECT config_json FROM crawl_sessions WHERE id = $1",
      [sessionId]
    );
    if (!rows.length || !rows[0].config_json) return null;
    try {
      return JSON.parse(rows[0].config_json);
    } catch {
      return null;
    }
  }

  async function updateSessionConfig(sessionId: number, config: CrawlConfig): Promise<void> {
    const d = await getDb();
    await d.execute(
      "UPDATE crawl_sessions SET config_json = $1 WHERE id = $2",
      [JSON.stringify(config), sessionId]
    );
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
    loadSessionConfig,
    updateSessionConfig,
  };
}
