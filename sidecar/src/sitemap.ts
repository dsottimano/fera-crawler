// Sitemap.xml discovery + parsing with sitemap-index recursion.

const MAX_URLS = 50000;
const MAX_SITEMAPS = 50;
const MAX_DEPTH = 3;
const FETCH_TIMEOUT = 15000;

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
    return await res.text();
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
