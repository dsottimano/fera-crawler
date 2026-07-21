// Sitemap.xml discovery + parsing with sitemap-index recursion.

import { gunzipSync } from "node:zlib";
import { readResponseCapped } from "./utils.js";

const MAX_URLS = 50000;
const MAX_SITEMAPS = 50;
const MAX_DEPTH = 3;
const FETCH_TIMEOUT = 15000;
// Cap the on-wire body so a hostile/huge sitemap can't exhaust memory. 30MB is
// far above any legitimate sitemap (the protocol caps uncompressed at 50MB, but
// on-wire they're XML that gzips hard). Decompressed output is separately capped
// to guard against gzip bombs.
const MAX_FETCH_BYTES = 30 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 60 * 1024 * 1024;

function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc[^>]*>([\s\S]*?)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const raw = m[1].trim();
    if (raw) {
      const decoded = raw
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
      out.push(decoded);
    }
  }
  return out;
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex\b/i.test(xml);
}

async function fetchXml(url: string, userAgent: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: { "User-Agent": userAgent, "Accept": "application/xml, text/xml, */*" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const { bytes } = await readResponseCapped(res, MAX_FETCH_BYTES);
    // Gzip magic (0x1f 0x8b): many sites publish only `.xml.gz` sitemaps served
    // WITHOUT a Content-Encoding header, so fetch doesn't auto-inflate them and
    // res.text() would decode raw gzip as UTF-8 garbage → zero URLs extracted,
    // silently under-seeding the crawl. Detect + inflate ourselves, with an
    // output cap so a gzip bomb can't blow up the heap.
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      try {
        return gunzipSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES }).toString("utf-8");
      } catch {
        return null;
      }
    }
    return Buffer.from(bytes).toString("utf-8");
  } catch {
    return null;
  }
}

export async function fetchSitemapUrls(
  sitemapUrl: string,
  userAgent = "Feracrawler",
): Promise<string[]> {
  const urls = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: sitemapUrl, depth: 0 }];

  while (queue.length > 0 && urls.size < MAX_URLS && visited.size < MAX_SITEMAPS) {
    const { url, depth } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    if (depth > MAX_DEPTH) continue;

    const xml = await fetchXml(url, userAgent);
    if (!xml) continue;

    const locs = extractLocs(xml);
    if (isSitemapIndex(xml)) {
      for (const loc of locs) queue.push({ url: loc, depth: depth + 1 });
    } else {
      for (const loc of locs) {
        urls.add(loc);
        if (urls.size >= MAX_URLS) break;
      }
    }
  }
  return Array.from(urls);
}

export async function discoverSitemapUrls(
  origin: string,
  fromRobots: string[],
  userAgent = "Feracrawler",
): Promise<string[]> {
  const seeds = fromRobots.length > 0 ? fromRobots : [origin.replace(/\/$/, "") + "/sitemap.xml"];
  const all = new Set<string>();
  for (const seed of seeds) {
    if (all.size >= MAX_URLS) break;
    const urls = await fetchSitemapUrls(seed, userAgent);
    for (const u of urls) {
      all.add(u);
      if (all.size >= MAX_URLS) break;
    }
  }
  return Array.from(all);
}

export const __test = { extractLocs, isSitemapIndex };
