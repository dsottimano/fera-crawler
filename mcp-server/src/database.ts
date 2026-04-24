import Database from "better-sqlite3";
import fs from "node:fs";
import { DB_PATH } from "./paths.js";
import type { CrawlResult, CrawlSession } from "./types.js";

function getDb(): Database.Database | null {
  if (!fs.existsSync(DB_PATH)) return null;
  return new Database(DB_PATH, { readonly: true });
}

export function listSessions(): CrawlSession[] {
  const db = getDb();
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT s.id, s.start_url, s.started_at, s.completed_at,
              COUNT(r.id) as result_count
       FROM crawl_sessions s
       LEFT JOIN crawl_results r ON r.session_id = s.id
       GROUP BY s.id
       ORDER BY s.started_at DESC
       LIMIT 50`
    ).all() as CrawlSession[];
  } finally {
    db.close();
  }
}

export function loadSessionResults(sessionId: number): CrawlResult[] {
  const db = getDb();
  if (!db) return [];
  try {
    const rows = db.prepare(
      `SELECT url, status, title, h1, h2, meta_description, canonical,
              internal_links, external_links, response_time, content_type,
              resource_type, size, error, word_count, meta_robots,
              is_indexable, is_noindex, is_nofollow,
              og_title, og_description, og_image, og_image_width, og_image_height,
              date_published, date_modified, redirect_url, server_header, seo_json
       FROM crawl_results WHERE session_id = ? ORDER BY id`
    ).all(sessionId) as any[];

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
      };
    });
  } finally {
    db.close();
  }
}
