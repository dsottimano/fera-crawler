import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { chromium, type BrowserContext, type Page } from "patchright";
import sharp from "sharp";
import { writeLine, writeAnyEvent } from "./pipeline.js";
import { BlockDetector, hostOf } from "./blockDetector.js";
import {
  log,
  phase,
  setQueueSize,
  setInFlight,
  recordCompletion,
  recordError,
} from "./observability.js";
import {
  buildStealthInitScript,
  generateFingerprint,
  fingerprintDigest,
  buildHeaders,
  buildUserAgent,
  parseUserAgent,
  DEFAULT_STEALTH_PATCHES,
  type StealthPatchConfig,
} from "./stealth.js";
import { PerHostRateLimiter, parseRetryAfter } from "./rate-limiter.js";
import { classifyResource } from "./utils.js";
import { RobotsCache } from "./robots.js";
import { discoverSitemapUrls } from "./sitemap.js";
import type { CrawlConfig, CrawlResult, MetaTag } from "./types.js";

/** Ensures a URL has a protocol prefix. */
export function ensureProtocol(url: string): string {
  if (!/^https?:\/\//i.test(url)) return "https://" + url;
  return url;
}

export async function killChromeForProfile(profileDir: string): Promise<void> {
  try {
    if (process.platform === "win32") {
      // Pass profile dir via stdin to avoid injection via backticks, $(), or quotes.
      const script = "$p = [Console]::In.ReadLine(); "
        + "Get-CimInstance Win32_Process | "
        + "Where-Object { $_.CommandLine -like ('*--user-data-dir=' + $p + '*') } | "
        + "ForEach-Object { $_.Terminate() }";
      execFileSync("powershell", ["-NoProfile", "-Command", script], {
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 5000,
        input: profileDir + "\n",
      });
    } else {
      let result: string;
      try {
        result = execFileSync("ps", ["ax", "-o", "pid,args"], { encoding: "utf8", timeout: 5000 });
      } catch {
        return;
      }
      const needle = `--user-data-dir=${profileDir}`;
      for (const line of result.trim().split("\n")) {
        if (!line.includes(needle)) continue;
        const pid = parseInt(line.trim(), 10);
        if (pid && pid !== process.pid) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      }
    }
  } catch {}

  for (const lockName of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    const lockFile = path.join(profileDir, lockName);
    try { fs.unlinkSync(lockFile); } catch {}
  }
  await new Promise((r) => setTimeout(r, 500));
}

export function findChromium(): string | undefined {
  if (process.env.FERA_CHROMIUM_PATH) {
    if (fs.existsSync(process.env.FERA_CHROMIUM_PATH)) {
      return process.env.FERA_CHROMIUM_PATH;
    }
  }

  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const binaryName = isWindows
    ? "chrome.exe"
    : isMac
      ? "Chromium.app/Contents/MacOS/Chromium"
      : "chrome";

  const resourcesDir = process.env.FERA_RESOURCES_DIR;
  const candidates = [
    ...(resourcesDir ? [path.join(resourcesDir, "chromium", binaryName)] : []),
    path.join(path.dirname(process.execPath), "chromium", binaryName),
    path.join(path.dirname(process.execPath), "..", "chromium", binaryName),
    path.join(path.dirname(process.execPath), "..", "resources", "chromium", binaryName),
    path.join(path.dirname(process.execPath), "..", "Resources", "chromium", binaryName),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  const home = os.homedir();
  let cacheDir: string;
  if (isWindows) {
    cacheDir = path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ms-playwright");
  } else if (isMac) {
    cacheDir = path.join(home, "Library", "Caches", "ms-playwright");
  } else {
    cacheDir = path.join(home, ".cache", "ms-playwright");
  }

  if (fs.existsSync(cacheDir)) {
    const entries = fs.readdirSync(cacheDir)
      .filter((e) => e.startsWith("chromium-"))
      .sort();
    if (entries.length > 0) {
      const latest = entries[entries.length - 1];
      const subdirs = isWindows
        ? ["chrome-win64", "chrome-win"]
        : isMac
          ? ["chrome-mac", "chrome-mac-arm64", "chrome-mac-x64"]
          : ["chrome-linux64", "chrome-linux"];
      for (const subdir of subdirs) {
        const cacheBinary = path.join(cacheDir, latest, subdir, binaryName);
        if (fs.existsSync(cacheBinary)) return cacheBinary;
      }
    }
  }

  return undefined;
}

export function getBrowserProfileDir(profileArg?: string): string {
  if (profileArg) return profileArg;

  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "com.fera.crawler", "browser-profile");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "com.fera.crawler", "browser-profile");
  }
  return path.join(home, ".local", "share", "com.fera.crawler", "browser-profile");
}

export const STEALTH_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  "--disable-features=AutomationControlled",
  "--disable-infobars",
  "--no-first-run",
  "--no-default-browser-check",
  "--password-store=basic",
];

// ── Image dimension parsing (no external deps) ──

function getImageDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;

  // PNG: bytes 16-23
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // GIF: bytes 6-9
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }

  // JPEG: scan for SOF marker
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let offset = 2;
    while (offset < buffer.length - 9) {
      if (buffer[offset] !== 0xFF) break;
      const marker = buffer[offset + 1];
      if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      if (offset + 3 >= buffer.length) break;
      const segLen = buffer.readUInt16BE(offset + 2);
      if (segLen < 2) break; // malformed — avoid infinite loop
      offset += 2 + segLen;
    }
  }

  // WebP
  if (buffer.length > 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const type = buffer.toString("ascii", 12, 16);
    if (type === "VP8 " && buffer.length > 29) {
      return { width: buffer.readUInt16LE(26) & 0x3FFF, height: buffer.readUInt16LE(28) & 0x3FFF };
    }
    if (type === "VP8L" && buffer.length > 25) {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
    }
    if (type === "VP8X" && buffer.length > 29) {
      return {
        width: (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1,
        height: (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1,
      };
    }
  }

  return null;
}

// ── Bounded-concurrency sharp writer ──
// Unbounded fire-and-forget sharp tasks can OOM on image-heavy crawls.
const SHARP_MAX_CONCURRENT = 4;
let sharpActive = 0;
const sharpQueue: Array<() => void> = [];

function enqueueSharpWrite(buffer: Buffer, filePath: string): void {
  const run = () => {
    sharpActive++;
    sharp(buffer)
      .webp({ quality: 80 })
      .toFile(filePath)
      .catch(() => {})
      .finally(() => {
        sharpActive--;
        const next = sharpQueue.shift();
        if (next) next();
      });
  };
  if (sharpActive < SHARP_MAX_CONCURRENT) run();
  else sharpQueue.push(run);
}

// ── og:image download + dimension extraction ──
// Fetches image, reads dimensions from buffer (instant), then compresses+saves
// to disk in the background. Returns dimensions without waiting for disk I/O.

async function downloadOgImageFile(
  imageUrl: string, pageUrl: string, downloadDir: string, userAgent?: string
): Promise<{ width: number; height: number; fileSize: number } | null> {
  try {
    const parsedPage = new URL(pageUrl);
    const domainDir = path.join(downloadDir, parsedPage.hostname);
    fs.mkdirSync(domainDir, { recursive: true });

    const parsedImg = new URL(imageUrl);
    let baseName = path.basename(parsedImg.pathname) || "og-image";
    baseName = baseName.replace(path.extname(baseName), "").replace(/[^a-zA-Z0-9._-]/g, "_");
    const hash = crypto.createHash("md5").update(imageUrl).digest("hex").slice(0, 8);
    // Always save as .webp after compression
    const filename = `${baseName}-${hash}.webp`;

    const filePath = path.join(domainDir, filename);
    const headers: Record<string, string> = {};
    if (userAgent) headers["User-Agent"] = userAgent;
    const response = await fetch(imageUrl, { signal: AbortSignal.timeout(15000), headers });
    if (!response.ok || !response.body) return null;

    const buffer = Buffer.from(await response.arrayBuffer());

    // Read dimensions from raw buffer (instant, no I/O)
    const dims = getImageDimensions(buffer);

    // Compress and save with bounded concurrency to prevent OOM on image-heavy crawls
    enqueueSharpWrite(buffer, filePath);

    if (!dims) return null;
    return { width: dims.width, height: dims.height, fileSize: buffer.length };
  } catch {
    return null;
  }
}

// ── Date standardization ──

function standardizeDate(raw: string): { date: string; time: string } {
  if (!raw) return { date: "", time: "" };
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return { date: "", time: "" };
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const min = String(d.getUTCMinutes()).padStart(2, "0");
    const ss = String(d.getUTCSeconds()).padStart(2, "0");
    return { date: `${dd}-${mm}-${yyyy}`, time: `${hh}:${min}:${ss} UTC` };
  } catch {
    return { date: "", time: "" };
  }
}

// ── Robots directive parsing ──

function parseRobotsDirectives(metaRobots: string, metaGooglebot: string, xRobotsTag: string) {
  const all = [metaRobots, metaGooglebot, xRobotsTag]
    .join(",")
    .toLowerCase()
    .split(",")
    .map((d) => d.trim());

  const isNoindex = all.includes("noindex") || all.includes("none");
  const isNofollow = all.includes("nofollow") || all.includes("none");
  const isIndexable = !isNoindex;

  return { isIndexable, isNoindex, isNofollow };
}

// ── SEO extraction script (string to avoid tsx/esbuild __name injection) ──
// This runs inside the browser via page.evaluate(). It must be plain JS as a
// string so that esbuild does not transform it or inject __name() helpers.
const EXTRACT_SEO_SCRIPT = `(() => {
  var _m = function(a, v) {
    var el = document.querySelector("meta[" + a + '="' + v + '"]');
    return el ? (el.getAttribute("content") || "").trim() : "";
  };

  var title = (document.querySelector("title") || {}).textContent || "";
  title = title.trim();
  var h1 = (document.querySelector("h1") || {}).textContent || "";
  h1 = h1.trim();
  var h2 = (document.querySelector("h2") || {}).textContent || "";
  h2 = h2.trim();
  var metaDesc = _m("name", "description") || _m("property", "description");
  var canonicalEl = document.querySelector('link[rel="canonical"]');
  var canonical = canonicalEl ? canonicalEl.getAttribute("href") || "" : "";

  var bodyText = document.body ? document.body.innerText || "" : "";
  // Word-count approximation — avoids allocating an N-element array on large DOMs.
  // ~5 chars per word is the standard English-text heuristic.
  var trimmed = bodyText.trim();
  var wordCount = trimmed ? Math.max(1, Math.round(trimmed.length / 5)) : 0;

  var metaRobots = _m("name", "robots");
  var metaGooglebot = _m("name", "googlebot");

  var ogTitle = _m("property", "og:title");
  var ogDescription = _m("property", "og:description");
  var ogType = _m("property", "og:type");
  var ogUrl = _m("property", "og:url");
  var ogImage = _m("property", "og:image");
  var ogImageWidthStr = _m("property", "og:image:width");
  var ogImageHeightStr = _m("property", "og:image:height");

  var articlePublished = _m("property", "article:published_time")
    || _m("name", "date") || _m("name", "publish-date") || _m("name", "pubdate")
    || _m("name", "dcterms.date") || _m("name", "DC.date.issued") || _m("property", "datePublished");
  var articleModified = _m("property", "article:modified_time")
    || _m("name", "last-modified") || _m("name", "dcterms.modified")
    || _m("name", "DC.date.modified") || _m("property", "dateModified");

  var jsonLdPublished = "";
  var jsonLdModified = "";
  var structuredTypes = {};
  try {
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < scripts.length; i++) {
      try {
        var json = JSON.parse(scripts[i].textContent || "{}");
        var items = Array.isArray(json) ? json : json["@graph"] ? json["@graph"] : [json];
        for (var j = 0; j < items.length; j++) {
          if (items[j].datePublished && !jsonLdPublished) jsonLdPublished = items[j].datePublished;
          if (items[j].dateModified && !jsonLdModified) jsonLdModified = items[j].dateModified;
          var t = items[j]["@type"];
          if (typeof t === "string") structuredTypes[t] = 1;
          else if (Array.isArray(t)) for (var ti = 0; ti < t.length; ti++) structuredTypes[t[ti]] = 1;
        }
      } catch(e2) {}
    }
  } catch(e) {}
  var structuredDataTypes = Object.keys(structuredTypes);

  var hreflang = [];
  var alternates = document.querySelectorAll('link[rel="alternate"][hreflang]');
  for (var hi = 0; hi < alternates.length && hreflang.length < 500; hi++) {
    var lang = alternates[hi].getAttribute("hreflang") || "";
    var href = alternates[hi].getAttribute("href") || "";
    if (lang && href) hreflang.push({ lang: lang, href: href });
  }

  var publishedRaw = articlePublished || jsonLdPublished;
  var modifiedRaw = articleModified || jsonLdModified;

  var metaTags = [];
  var metas = document.querySelectorAll("meta");
  for (var k = 0; k < metas.length; k++) {
    var el = metas[k];
    var nm = el.getAttribute("name") || "";
    var pr = el.getAttribute("property") || "";
    var ct = el.getAttribute("content") || "";
    var he = el.getAttribute("http-equiv") || "";
    if (ct && (nm || pr || he)) {
      metaTags.push({ name: nm || he, property: pr, content: ct });
    }
  }

  var anchors = document.querySelectorAll("a[href]");
  var internal = 0;
  var external = 0;
  var internalUrls = [];
  var outlinksSet = Object.create(null);
  var allOutlinks = [];
  var OUTLINK_CAP = 5000;
  for (var ai = 0; ai < anchors.length; ai++) {
    try {
      var href = new URL(anchors[ai].href, location.origin);
      href.hash = "";
      var h = href.href;
      if (!outlinksSet[h] && allOutlinks.length < OUTLINK_CAP) {
        outlinksSet[h] = 1;
        allOutlinks.push(h);
      }
      if (href.hostname === location.hostname) {
        internal++;
        if (internalUrls.length < OUTLINK_CAP) internalUrls.push(h);
      } else {
        external++;
      }
    } catch(e) {}
  }

  return {
    title: title, h1: h1, h2: h2, metaDescription: metaDesc, canonical: canonical, wordCount: wordCount,
    metaRobots: metaRobots, metaGooglebot: metaGooglebot,
    ogTitle: ogTitle, ogDescription: ogDescription, ogType: ogType, ogUrl: ogUrl, ogImage: ogImage,
    ogImageWidth: ogImageWidthStr ? parseInt(ogImageWidthStr, 10) || 0 : 0,
    ogImageHeight: ogImageHeightStr ? parseInt(ogImageHeightStr, 10) || 0 : 0,
    publishedRaw: publishedRaw, modifiedRaw: modifiedRaw,
    metaTags: metaTags,
    internalLinks: internal, externalLinks: external,
    internalUrls: internalUrls, allOutlinks: allOutlinks,
    hreflang: hreflang,
    structuredDataTypes: structuredDataTypes,
  };
})()`;

// ── Core Web Vitals init script ──
// Installed once per context. Buffers LCP and CLS observations on window.__feraVitals
// so they can be read after the load event without extra round-trips.
export const VITALS_INIT_SCRIPT = `(() => {
  if (window.__feraVitalsInstalled) return;
  window.__feraVitalsInstalled = true;
  window.__feraVitals = { lcp: 0, cls: 0 };
  try {
    new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (e.startTime > window.__feraVitals.lcp) window.__feraVitals.lcp = e.startTime;
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch(e) {}
  try {
    new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.hadRecentInput) window.__feraVitals.cls += e.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch(e) {}
})()`;

// Reads navigation timing + vitals out of the page.
const READ_PERF_SCRIPT = `(() => {
  var nav = performance.getEntriesByType("navigation")[0];
  var fcpEntry = performance.getEntriesByName("first-contentful-paint")[0];
  var v = window.__feraVitals || { lcp: 0, cls: 0 };
  return {
    ttfb: nav ? Math.round(nav.responseStart) : 0,
    domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : 0,
    loadTime: nav ? Math.round(nav.loadEventEnd) : 0,
    fcp: fcpEntry ? Math.round(fcpEntry.startTime) : 0,
    lcp: Math.round(v.lcp || 0),
    cls: Math.round((v.cls || 0) * 1000) / 1000,
  };
})()`;

// ── Security-header audit ──

function auditSecurityHeaders(headers: Record<string, string>): CrawlResult["securityHeaders"] {
  const has = (k: string) => Boolean(headers[k.toLowerCase()]);
  return {
    hsts: has("strict-transport-security"),
    csp: has("content-security-policy") || has("content-security-policy-report-only"),
    xFrameOptions: has("x-frame-options"),
    referrerPolicy: has("referrer-policy"),
    xContentTypeOptions: has("x-content-type-options"),
    permissionsPolicy: has("permissions-policy") || has("feature-policy"),
  };
}

// ── Redirect-chain capture ──

function captureRedirectChain(finalResponse: any): string[] {
  const chain: string[] = [];
  try {
    let req = finalResponse?.request?.();
    // Walk backwards through redirectedFrom() links.
    const seen = new Set<string>();
    let prev = req?.redirectedFrom?.();
    while (prev) {
      const url = prev.url();
      if (seen.has(url)) break;
      seen.add(url);
      chain.unshift(url);
      prev = prev.redirectedFrom?.();
    }
  } catch {}
  return chain;
}

// ── Main page crawl ──

interface CrawlPageOpts {
  downloadOgImage?: boolean;
  downloadDir?: string;
  userAgent?: string;
  scraperRules?: Array<{ name: string; selector: string }>;
  captureVitals?: boolean;
}

export async function crawlPage(
  page: Page, url: string, opts?: CrawlPageOpts
): Promise<{ result: CrawlResult; discoveredLinks: string[] }> {
  const startTime = Date.now();
  let status = 0;
  let contentType = "";
  let size = 0;
  let error: string | undefined;
  let discoveredLinks: string[] = [];
  let responseHeaders: Record<string, string> = {};
  let redirectUrl: string | undefined;
  let serverHeader: string | undefined;

  // Per-request event collectors. Listeners attached before goto, detached in finally.
  const jsErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const onPageError = (err: Error) => {
    if (jsErrors.length < 50) jsErrors.push(err.message);
  };
  const onConsole = (msg: any) => {
    if (msg.type() === "error" && consoleErrors.length < 50) {
      consoleErrors.push(msg.text());
    }
  };
  const onRequestFailed = (req: any) => {
    if (failedRequests.length < 100) failedRequests.push(req.url());
  };
  // Capture HTTP 4xx/5xx subresources (not network failures, which fire above).
  const onResponse = (resp: any) => {
    try {
      const s = resp.status();
      if (s >= 400 && resp.url() !== url && failedRequests.length < 100) {
        failedRequests.push(resp.url());
      }
    } catch {}
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);

  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const responseTime = Date.now() - startTime;
    status = response?.status() ?? 0;

    if (response) {
      try {
        responseHeaders = await response.allHeaders();
      } catch {
        responseHeaders = response.headers();
      }
      contentType = responseHeaders["content-type"] ?? "";
      serverHeader = responseHeaders["server"] ?? undefined;

      const finalUrl = page.url();
      if (finalUrl !== url) redirectUrl = finalUrl;
    }

    const contentLength = responseHeaders["content-length"];
    if (contentLength) {
      const parsed = parseInt(contentLength, 10);
      if (!isNaN(parsed)) size = parsed;
    }
    if (!size) {
      try {
        const body = await response?.body();
        size = body ? body.length : 0;
      } catch {}
    }

    // Extract X-Robots-Tag from response headers
    const xRobotsTag = responseHeaders["x-robots-tag"] ?? "";

    // Use string-based evaluate to avoid tsx/esbuild __name() injection
    const data: any = await page.evaluate(EXTRACT_SEO_SCRIPT);

    // Run scraper rules
    const scraper: Record<string, { value: string; appears: boolean }> = {};
    if (opts?.scraperRules?.length) {
      const scraperData = await page.evaluate((rules: Array<{ name: string; selector: string }>) => {
        const results: Record<string, { value: string; appears: boolean }> = {};
        for (const rule of rules) {
          const el = document.querySelector(rule.selector);
          results[rule.name] = {
            value: el ? (el.textContent || "").trim().substring(0, 1000) : "",
            appears: !!el,
          };
        }
        return results;
      }, opts.scraperRules);
      Object.assign(scraper, scraperData);
    }

    discoveredLinks = data.internalUrls;

    // Resolve og:image URL
    let ogImageUrl = "";
    if (data.ogImage) {
      try { ogImageUrl = new URL(data.ogImage, url).href; } catch { ogImageUrl = data.ogImage; }
    }

    // og:image dimensions — meta tag declared values
    const ogImageWidth = data.ogImageWidth;
    const ogImageHeight = data.ogImageHeight;
    let ogImageWidthReal = 0;
    let ogImageHeightReal = 0;
    let ogImageFileSize = 0;

    // Download og:image: fetch + read real dimensions (fast), compress+save in background
    if (ogImageUrl && opts?.downloadOgImage && opts.downloadDir) {
      const imgData = await downloadOgImageFile(ogImageUrl, url, opts.downloadDir, opts.userAgent);
      if (imgData) {
        ogImageWidthReal = imgData.width;
        ogImageHeightReal = imgData.height;
        ogImageFileSize = imgData.fileSize;
      }
    }

    // Standardize dates
    const published = standardizeDate(data.publishedRaw);
    let modified = standardizeDate(data.modifiedRaw);
    // Fall back to Last-Modified header for modified date
    if (!modified.date && responseHeaders["last-modified"]) {
      modified = standardizeDate(responseHeaders["last-modified"]);
    }

    // Robots directives
    const directives = parseRobotsDirectives(data.metaRobots, data.metaGooglebot, xRobotsTag);

    // De-duplicate outlinks
    const uniqueOutlinks = [...new Set(data.allOutlinks)] as string[];

    const redirectChain = captureRedirectChain(response);
    const securityHeaders = auditSecurityHeaders(responseHeaders);

    // Perf: nav timing is available after DCL. LCP/CLS require a load-event wait.
    if (opts?.captureVitals) {
      await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
    }
    let perf = { ttfb: 0, domContentLoaded: 0, loadTime: 0, fcp: 0, lcp: 0, cls: 0 };
    try {
      perf = await page.evaluate(READ_PERF_SCRIPT) as typeof perf;
    } catch {}

    return {
      result: {
        url,
        status,
        title: data.title,
        h1: data.h1,
        h2: data.h2,
        metaDescription: data.metaDescription,
        canonical: data.canonical,
        wordCount: data.wordCount,
        metaRobots: data.metaRobots,
        metaGooglebot: data.metaGooglebot,
        xRobotsTag,
        isIndexable: directives.isIndexable,
        isNoindex: directives.isNoindex,
        isNofollow: directives.isNofollow,
        ogTitle: data.ogTitle,
        ogDescription: data.ogDescription,
        ogType: data.ogType,
        ogUrl: data.ogUrl,
        ogImage: ogImageUrl,
        ogImageWidth,
        ogImageHeight,
        ogImageWidthReal,
        ogImageHeightReal,
        ogImageRatio: ogImageWidthReal && ogImageHeightReal
          ? +(ogImageWidthReal / ogImageHeightReal).toFixed(2)
          : ogImageWidth && ogImageHeight ? +(ogImageWidth / ogImageHeight).toFixed(2) : 0,
        ogImageFileSize,
        datePublished: published.date,
        dateModified: modified.date,
        datePublishedTime: published.time,
        dateModifiedTime: modified.time,
        internalLinks: data.internalLinks,
        externalLinks: data.externalLinks,
        outlinks: uniqueOutlinks,
        responseTime,
        contentType,
        resourceType: classifyResource(contentType),
        size,
        responseHeaders,
        redirectUrl,
        serverHeader,
        metaTags: data.metaTags,
        scraper,
        redirectChain,
        hreflang: data.hreflang ?? [],
        structuredDataTypes: data.structuredDataTypes ?? [],
        securityHeaders,
        inSitemap: false,
        blockedByRobots: false,
        jsErrors,
        consoleErrors,
        failedRequests,
        perf,
      },
      discoveredLinks,
    };
  } catch (err: any) {
    return {
      result: {
        url, status: 0, title: "", h1: "", h2: "", metaDescription: "", canonical: "",
        wordCount: 0, metaRobots: "", metaGooglebot: "", xRobotsTag: "",
        isIndexable: false, isNoindex: false, isNofollow: false,
        ogTitle: "", ogDescription: "", ogType: "", ogUrl: "", ogImage: "",
        ogImageWidth: 0, ogImageHeight: 0,
        ogImageWidthReal: 0, ogImageHeightReal: 0,
        ogImageRatio: 0, ogImageFileSize: 0,
        datePublished: "", dateModified: "", datePublishedTime: "", dateModifiedTime: "",
        internalLinks: 0, externalLinks: 0, outlinks: [],
        responseTime: Date.now() - startTime, contentType: "", resourceType: "Other",
        size: 0, error: err.message, responseHeaders: {},
        metaTags: [],
        scraper: {},
        redirectChain: [],
        hreflang: [],
        structuredDataTypes: [],
        securityHeaders: {
          hsts: false, csp: false, xFrameOptions: false,
          referrerPolicy: false, xContentTypeOptions: false, permissionsPolicy: false,
        },
        inSitemap: false,
        blockedByRobots: false,
        jsErrors,
        consoleErrors,
        failedRequests,
        perf: { ttfb: 0, domContentLoaded: 0, loadTime: 0, fcp: 0, lcp: 0, cls: 0 },
      },
      discoveredLinks: [],
    };
  } finally {
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
    page.off("requestfailed", onRequestFailed);
    page.off("response", onResponse);
  }
}

// ── Robots-blocked result stub (URL was in-scope but robots.txt disallowed it) ──

function makeBlockedResult(url: string, inSitemap: boolean): CrawlResult {
  return {
    url, status: 0, title: "", h1: "", h2: "", metaDescription: "", canonical: "",
    wordCount: 0, metaRobots: "", metaGooglebot: "", xRobotsTag: "",
    isIndexable: false, isNoindex: false, isNofollow: false,
    ogTitle: "", ogDescription: "", ogType: "", ogUrl: "", ogImage: "",
    ogImageWidth: 0, ogImageHeight: 0,
    ogImageWidthReal: 0, ogImageHeightReal: 0,
    ogImageRatio: 0, ogImageFileSize: 0,
    datePublished: "", dateModified: "", datePublishedTime: "", dateModifiedTime: "",
    internalLinks: 0, externalLinks: 0, outlinks: [],
    responseTime: 0, contentType: "", resourceType: "Other",
    size: 0, responseHeaders: {},
    metaTags: [], scraper: {},
    redirectChain: [], hreflang: [], structuredDataTypes: [],
    securityHeaders: {
      hsts: false, csp: false, xFrameOptions: false,
      referrerPolicy: false, xContentTypeOptions: false, permissionsPolicy: false,
    },
    inSitemap,
    blockedByRobots: true,
    jsErrors: [],
    consoleErrors: [],
    failedRequests: [],
    perf: { ttfb: 0, domContentLoaded: 0, loadTime: 0, fcp: 0, lcp: 0, cls: 0 },
  };
}

// Park-by-detector result stub — surface parked URLs so user can select +
// recrawl them with a better config instead of losing them on shutdown.
function makeParkedResult(url: string, host: string): CrawlResult {
  const r = makeBlockedResult(url, false);
  r.blockedByRobots = false;
  r.error = `host_blocked_by_detector:${host}`;
  return r;
}

// ── Unlimited crawl helper ──
function withinLimit(processed: number, maxRequests: number): boolean {
  return maxRequests === 0 || processed < maxRequests;
}
function canEnqueue(queueLen: number, processed: number, maxRequests: number): boolean {
  return maxRequests === 0 || queueLen + processed < maxRequests;
}

export async function runCrawler(config: CrawlConfig): Promise<void> {
  const executablePath = findChromium();
  const userDataDir = getBrowserProfileDir(config.browserProfile);

  fs.mkdirSync(userDataDir, { recursive: true });

  const headless = config.headless !== false;

  // Resolve stealth config upfront so UA + headers are derived coherently
  // with the init script we're about to install.
  const stealthSeed = config.startUrl;
  const patches: StealthPatchConfig = {
    ...DEFAULT_STEALTH_PATCHES,
    ...(config.stealthConfig as Partial<StealthPatchConfig> | undefined),
  };
  // If the user supplied a UA override AND it parses as Chrome, realign the
  // whole fingerprint to match it — same UA-CH brands, Sec-CH-UA-Platform,
  // navigator.platform. Non-Chrome UAs (Firefox/Safari) return null: we'll
  // pass them through verbatim but skip Chrome-specific HTTP headers.
  const uaOverride = config.userAgent?.trim() || "";
  const parsedUa = uaOverride ? parseUserAgent(uaOverride) : null;
  const fp = generateFingerprint({
    seed: stealthSeed,
    ...(parsedUa
      ? {
          platform: parsedUa.platform,
          chromeMajor: parsedUa.chromeMajor,
          chromeFullVersion: parsedUa.chromeFullVersion,
        }
      : {}),
  });
  const fpDigest = fingerprintDigest(fp);
  const stealthEnabled = patches.enabled !== false;
  // Non-Chrome override: skip Sec-CH-UA headers entirely (real Firefox/Safari
  // don't send them). Chrome override or no override: derive from fingerprint.
  const sendChromeHeaders = stealthEnabled && (!uaOverride || parsedUa !== null);
  const fpHeaders = sendChromeHeaders ? buildHeaders(fp) : undefined;
  const fpUserAgent = stealthEnabled ? buildUserAgent(fp) : undefined;

  phase("startup", {
    startUrl: config.startUrl,
    mode: config.mode,
    concurrency: config.concurrency,
    maxRequests: config.maxRequests,
    headless,
    respectRobots: !!config.respectRobots,
    captureVitals: !!config.captureVitals,
    downloadOgImage: !!config.downloadOgImage,
    stealth: stealthEnabled,
    sessionWarmup: !!config.sessionWarmup,
    perHostDelay: config.perHostDelay ?? 500,
    perHostConcurrency: config.perHostConcurrency ?? 2,
    chromium: executablePath ?? "(patchright-bundled)",
    profileDir: userDataDir,
  });
  log("info", "crawler starting", {
    startUrl: config.startUrl,
    headless,
    stealth: stealthEnabled,
    engine: stealthEnabled ? "patchright+custom-stealth" : "patchright+bundled-chromium",
  });

  await killChromeForProfile(userDataDir);

  // Merge headers: fingerprint-derived baseline (when stealth on) → user custom headers on top.
  const mergedHeaders: Record<string, string> | undefined = (() => {
    if (!fpHeaders && !config.customHeaders) return undefined;
    return { ...(fpHeaders ?? {}), ...(config.customHeaders ?? {}) };
  })();

  // Resolve effective User-Agent: user-supplied wins, else fingerprint, else Playwright default.
  const effectiveUa = config.userAgent || fpUserAgent;

  // Patchright best-practice mode: when our custom stealth is OFF we trust
  // Patchright's binary-level patches entirely. Per upstream:
  //   - use system Chrome (channel) over bundled Chromium when possible
  //   - viewport: null (don't override window dimensions)
  //   - do NOT inject userAgent or custom headers (breaks their stealth)
  // When stealth is ON we keep our own full stack (UA + Sec-CH-UA + init script).
  const launchOpts = {
    headless,
    executablePath,
    args: headless ? STEALTH_ARGS : [...STEALTH_ARGS, "--start-maximized"],
    ignoreDefaultArgs: ["--enable-automation"] as string[],
    ...(stealthEnabled
      ? (headless ? {} : { viewport: null as null })
      : {
          viewport: null as null,
          // Prefer system Chrome (Patchright best practice) when available;
          // fall back to Patchright's bundled patched Chromium otherwise.
        }),
    ...(stealthEnabled && effectiveUa ? { userAgent: effectiveUa } : {}),
    ...(stealthEnabled && mergedHeaders ? { extraHTTPHeaders: mergedHeaders } : {}),
  };

  let context: BrowserContext;
  phase("browser-launch");
  try {
    context = await chromium.launchPersistentContext(userDataDir, launchOpts);
    log("info", "browser launched", { headless });
  } catch (err: any) {
    log("warn", "browser launch failed; retrying after profile cleanup", { error: String(err?.message ?? err) });
    if (err.message?.includes("existing browser session") || err.message?.includes("Target page, context or browser has been closed")) {
      await new Promise((r) => setTimeout(r, 2000));
      await killChromeForProfile(userDataDir);
      context = await chromium.launchPersistentContext(userDataDir, launchOpts);
      log("info", "browser launched on retry");
    } else {
      recordError();
      log("error", "browser launch fatal", { error: String(err?.message ?? err) });
      throw err;
    }
  }

  // Install stealth init script (unless master toggle is off).
  if (stealthEnabled) {
    const disabled = Object.entries(patches)
      .filter(([k, v]) => k !== "enabled" && !v)
      .map(([k]) => k);
    await context.addInitScript(
      buildStealthInitScript({ seed: stealthSeed, patches }),
    );
    log("info", "stealth fingerprint applied", {
      digest: fpDigest,
      platform: fp.platform,
      chrome: fp.chromeFullVersion,
      screen: fp.screenWidth + "x" + fp.screenHeight,
      cpu: fp.hardwareConcurrency,
      memGB: fp.deviceMemory,
      webglVendor: fp.webglVendor,
      prefersDark: fp.prefersDark,
      colorGamutP3: fp.colorGamutP3,
      disabledPatches: disabled.length ? disabled : undefined,
    });
  } else {
    log("warn", "stealth DISABLED for this crawl (master toggle off)");
  }

  if (config.captureVitals) {
    await context.addInitScript(VITALS_INIT_SCRIPT);
  }

  // Per-host rate limiter (defaults: 500ms between request starts, 2 concurrent per host).
  const rateLimiter = new PerHostRateLimiter(
    config.perHostDelay ?? 500,
    config.perHostConcurrency ?? 2,
  );
  log("info", "rate limiter configured", {
    perHostDelayMs: rateLimiter.delayMs,
    perHostConcurrency: rateLimiter.maxConcurrency,
  });

  // Session warmup: visit each unique origin root so anti-bot cookies
  // (_abck, ak_bmsc, __cf_bm, etc.) can establish before deep-linking.
  if (config.sessionWarmup) {
    const warmupOrigins = new Set<string>();
    try { warmupOrigins.add(new URL(ensureProtocol(config.startUrl)).origin); } catch {}
    if (config.mode === "list" && config.urls?.length) {
      for (const u of config.urls) {
        try { warmupOrigins.add(new URL(ensureProtocol(u)).origin); } catch {}
      }
    }
    for (const origin of warmupOrigins) {
      phase("warmup", { origin });
      log("info", "session warmup", { origin });
      const warmupPage = await context.newPage();
      try {
        const resp = await warmupPage.goto(origin, { waitUntil: "domcontentloaded", timeout: 15000 });
        const status = resp?.status() ?? 0;
        await warmupPage.waitForTimeout(2500);
        const blocked = status === 403 || status === 429 || status === 503;
        log(blocked ? "warn" : "info", "warmup complete", { origin, status, blocked });
      } catch (err: any) {
        log("warn", "warmup navigation failed", { origin, error: String(err?.message ?? err) });
      } finally {
        await warmupPage.close().catch(() => {});
      }
    }
  }

  // Set up og:image download directory
  let ogImageDownloadDir: string | undefined;
  if (config.downloadOgImage) {
    ogImageDownloadDir = path.join(userDataDir, "..", "og-images");
    fs.mkdirSync(ogImageDownloadDir, { recursive: true });
  }
  const crawlPageOpts: CrawlPageOpts = {
    ...(config.downloadOgImage ? { downloadOgImage: true, downloadDir: ogImageDownloadDir, userAgent: config.userAgent } : {}),
    ...(config.scraperRules?.length ? { scraperRules: config.scraperRules } : {}),
    ...(config.captureVitals ? { captureVitals: true } : {}),
  };

  const visited = new Set<string>();
  // Resume support: pre-seed visited so already-crawled URLs are skipped.
  if (config.excludeUrls?.length) {
    for (const u of config.excludeUrls) visited.add(u);
    // Spider mode still crawls the start URL — without it, link discovery
    // can't bootstrap a resumed crawl.
    if (config.mode === "spider" && config.startUrl) {
      visited.delete(ensureProtocol(config.startUrl));
    }
    log("info", "exclude list seeded", { count: config.excludeUrls.length });
  }
  const queue: string[] = [];
  const sitemapUrls = new Set<string>();
  let processed = 0;

  // URLs parked while their host is gated. Resume-host moves them back to queue.
  const parkedByHost = new Map<string, string[]>();

  // Auto-cooldown callback: when the detector's timer fires, requeue the
  // host's parked URLs and tell the frontend so the banner can clear.
  const detector = new BlockDetector({
    onAutoClear: (host) => {
      const requeued = unparkHost(host);
      log("info", "host auto-resumed after cooldown", { host, requeued });
      writeAnyEvent({
        type: "block-cooldown-cleared",
        ts: Date.now(),
        host,
        requeued,
      });
    },
  });

  function park(url: string): void {
    const h = hostOf(url);
    let bucket = parkedByHost.get(h);
    if (!bucket) {
      bucket = [];
      parkedByHost.set(h, bucket);
    }
    bucket.push(url);
    // Emit a placeholder result so the parked URL is visible in the grid
    // (and persisted to the DB session). Without this, parked URLs vanish
    // on stop because the sidecar's in-memory parkedByHost map dies with it.
    writeLine(makeParkedResult(url, h));
  }

  function unparkHost(host: string): number {
    const bucket = parkedByHost.get(host);
    if (!bucket || bucket.length === 0) return 0;
    const n = bucket.length;
    for (const u of bucket) queue.push(u);
    parkedByHost.delete(host);
    setQueueSize(queue.length);
    return n;
  }

  function dropHost(host: string): number {
    const bucket = parkedByHost.get(host);
    const n = bucket ? bucket.length : 0;
    parkedByHost.delete(host);
    return n;
  }

  // Stdin command listener: {"cmd":"resume-host","host":"..."} / {"cmd":"stop-host","host":"..."}
  let stdinBuf = "";
  const onStdinData = (chunk: Buffer): void => {
    stdinBuf += chunk.toString("utf8");
    let idx: number;
    while ((idx = stdinBuf.indexOf("\n")) !== -1) {
      const line = stdinBuf.slice(0, idx).trim();
      stdinBuf = stdinBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (!msg || typeof msg !== "object") continue;
        if (msg.cmd === "resume-host" && typeof msg.host === "string") {
          detector.clearGate(msg.host);
          const moved = unparkHost(msg.host);
          log("info", "host resumed", { host: msg.host, requeued: moved });
        } else if (msg.cmd === "stop-host" && typeof msg.host === "string") {
          detector.clearGate(msg.host);
          const dropped = dropHost(msg.host);
          log("info", "host stopped", { host: msg.host, dropped });
        }
      } catch (err) {
        log("warn", "invalid stdin command", { line, error: String((err as Error)?.message ?? err) });
      }
    }
  };
  process.stdin.on("data", onStdinData);
  process.stdin.resume();

  // Robots.txt cache (only when respecting robots — null otherwise for zero overhead)
  const robotsCache = config.respectRobots ? new RobotsCache(config.userAgent) : null;

  if (config.mode === "list" && config.urls?.length) {
    for (const u of config.urls) queue.push(ensureProtocol(u));
  } else {
    const startUrl = ensureProtocol(config.startUrl);
    queue.push(startUrl);

    // Sitemap discovery — fetch on spider start, seed queue, and track inSitemap flags.
    if (config.respectRobots) {
      phase("sitemap-discovery");
      try {
        const origin = new URL(startUrl).origin;
        const fromRobots = await robotsCache!.getSitemaps(origin);
        log("info", "sitemaps declared in robots.txt", { count: fromRobots.length, origin });
        const discovered = await discoverSitemapUrls(origin, fromRobots, config.userAgent);
        log("info", "sitemap urls discovered", { count: discovered.length });
        writeLine({ event: "sitemap-discovered", count: discovered.length } as any);
        for (const u of discovered) {
          sitemapUrls.add(u);
          try {
            if (new URL(u).origin === origin && !visited.has(u)) queue.push(u);
          } catch {}
        }
      } catch (e: any) {
        log("warn", "sitemap discovery failed", { error: String(e?.message ?? e) });
      }
    }
  }
  setQueueSize(queue.length);

  const effectiveConcurrency = headless ? config.concurrency : 1;
  const effectiveDelay = headless ? (config.delay ?? 0) : Math.max(config.delay ?? 0, 1000);

  /**
   * Crawl a URL with per-host rate limiting + one retry on 429/503 with
   * Retry-After. 403 is NOT retried — retrying escalates adaptive bot
   * walls (Akamai / DataDome) and burns IP reputation.
   */
  async function crawlWithPolicy(
    page: Page,
    url: string,
  ): Promise<{ result: CrawlResult; discoveredLinks: string[] }> {
    let host = "";
    try { host = new URL(url).host; } catch {}

    const doOnce = async () => {
      if (host) await rateLimiter.acquire(host);
      try {
        return await crawlPage(page, url, crawlPageOpts);
      } finally {
        if (host) rateLimiter.release(host);
      }
    };

    let outcome = await doOnce();
    const status = outcome.result.status;
    if (status === 429 || status === 503) {
      const ra = outcome.result.responseHeaders?.["retry-after"]
        ?? outcome.result.responseHeaders?.["Retry-After"];
      const waitMs = Math.min(parseRetryAfter(ra), 60_000);
      if (waitMs > 0) {
        log("warn", "backoff: Retry-After observed", { url, status, waitMs });
        await new Promise((r) => setTimeout(r, waitMs));
        log("info", "backoff complete, retrying once", { url });
        outcome = await doOnce();
      } else {
        log("warn", "server signaled rate limit but no Retry-After", { url, status });
      }
    } else if (status === 403) {
      // Don't retry — just note the block signal. Extract known block-vendor
      // identifiers from the response body so we can tell which edge product
      // (Akamai / Cloudflare / DataDome / PerimeterX) actually blocked us.
      const h = outcome.result.responseHeaders ?? {};
      const server = h["server"] ?? h["Server"] ?? "";
      const akamaiRef = (outcome.result.error ?? "").match(/Reference[^#]*#([0-9a-f.]+)/i)?.[1];
      const cfRay = h["cf-ray"] ?? h["CF-RAY"];
      const dataDome = h["x-datadome"] ?? h["x-dd-b"];
      log("warn", "403 block (not retrying)", {
        url,
        server: server || undefined,
        cfRay: cfRay || undefined,
        akamaiRef: akamaiRef || undefined,
        dataDome: dataDome || undefined,
      });
    }
    return outcome;
  }

  function recordResult(result: CrawlResult): void {
    writeLine(result);
    const h = hostOf(result.url);
    if (!h) return;
    const trip = detector.record({ url: result.url, status: result.status, title: result.title }, h);
    if (trip) {
      writeAnyEvent(trip);
      log("warn", "block-detected: host paused", { host: trip.host, stats: trip.stats, reasons: trip.reasons });
    }
  }

  try {
    let reusePage: Page | null = null;
    if (!headless) {
      const existingPages = context.pages();
      reusePage = existingPages.length > 0 ? existingPages[0] : await context.newPage();
      for (let i = 1; i < existingPages.length; i++) {
        await existingPages[i].close().catch(() => {});
      }
    }

    while (queue.length > 0 && withinLimit(processed, config.maxRequests)) {
      const batchSize = config.maxRequests === 0
        ? effectiveConcurrency
        : Math.min(effectiveConcurrency, config.maxRequests - processed);
      const batch = queue.splice(0, batchSize);
      const tasks: string[] = [];
      for (const url of batch) {
        if (visited.has(url)) continue;
        if (detector.isGated(hostOf(url))) {
          park(url);
          continue;
        }
        visited.add(url);
        tasks.push(url);
      }

      if (tasks.length === 0) continue;

      // Split tasks into blocked-by-robots (recorded, not crawled) and allowed.
      const allowed: string[] = [];
      if (robotsCache) {
        for (const url of tasks) {
          const ok = await robotsCache.isAllowed(url);
          if (ok) {
            allowed.push(url);
          } else {
            writeLine(makeBlockedResult(url, sitemapUrls.has(url)));
            processed++;
          }
        }
      } else {
        allowed.push(...tasks);
      }

      if (reusePage) {
        setInFlight(1);
        for (const url of allowed) {
          if (effectiveDelay > 0) await new Promise((r) => setTimeout(r, effectiveDelay));
          log("debug", "navigating", { url });
          const { result, discoveredLinks } = await crawlWithPolicy(reusePage, url);
          if (result.error) {
            recordError();
            log("warn", "page error", { url, error: result.error, status: result.status });
          } else {
            log("debug", "page complete", { url, status: result.status, ms: result.responseTime, links: discoveredLinks.length });
          }
          if (sitemapUrls.has(url)) result.inSitemap = true;
          recordResult(result);
          processed++;
          recordCompletion();
          if (config.mode === "spider" && !(config.respectRobots && result.isNofollow)) {
            for (const link of discoveredLinks) {
              if (!visited.has(link) && canEnqueue(queue.length, processed, config.maxRequests)) {
                queue.push(link);
              }
            }
          }
          setQueueSize(queue.length);
        }
        setInFlight(0);
      } else {
        // Stagger tasks so `delay` throttles request rate (1 request per `delay` ms),
        // rather than firing all N concurrent requests simultaneously after one delay.
        setInFlight(allowed.length);
        log("debug", "batch start", { size: allowed.length, queueRemaining: queue.length });
        const results = await Promise.all(
          allowed.map(async (url, i) => {
            if (effectiveDelay > 0) await new Promise((r) => setTimeout(r, effectiveDelay * i));
            log("debug", "navigating", { url });
            const page = await context.newPage();
            try {
              return { url, data: await crawlWithPolicy(page, url) };
            } finally {
              await page.close();
            }
          }),
        );
        setInFlight(0);

        for (const { url, data } of results) {
          const { result, discoveredLinks } = data;
          if (result.error) {
            recordError();
            log("warn", "page error", { url, error: result.error, status: result.status });
          } else {
            log("debug", "page complete", { url, status: result.status, ms: result.responseTime, links: discoveredLinks.length });
          }
          if (sitemapUrls.has(url)) result.inSitemap = true;
          recordResult(result);
          processed++;
          recordCompletion();
          if (config.mode === "spider" && !(config.respectRobots && result.isNofollow)) {
            for (const link of discoveredLinks) {
              if (!visited.has(link) && canEnqueue(queue.length, processed, config.maxRequests)) {
                queue.push(link);
              }
            }
          }
        }
        setQueueSize(queue.length);
      }
    }
  } finally {
    phase("shutdown", { processed });
    log("info", "crawl finished", { processed });
    await context.close().catch(() => {});
    process.stdin.off("data", onStdinData);
    process.stdin.pause();
  }
}

/**
 * Opens a visible browser window for the user to sign in.
 */
export async function openBrowser(rawUrl: string, profileDir?: string): Promise<void> {
  const url = ensureProtocol(rawUrl);
  const executablePath = findChromium();
  const userDataDir = getBrowserProfileDir(profileDir);

  fs.mkdirSync(userDataDir, { recursive: true });
  await killChromeForProfile(userDataDir);

  writeLine({ event: "browser-opened", url } as any);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath,
    args: [...STEALTH_ARGS, "--start-maximized"],
    ignoreDefaultArgs: ["--enable-automation"],
    viewport: null,
  });

  await context.addInitScript(buildStealthInitScript({ seed: url }));

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  let cookiesDumped = false;
  context.on("page", () => {});

  const dumpCookiesBeforeClose = async () => {
    if (cookiesDumped) return;
    cookiesDumped = true;
    try {
      const cookies = await context.cookies();
      writeLine({ event: "profile-data", cookies } as any);
    } catch {}
  };

  context.on("page", (p) => {
    p.on("close", async () => {
      if (context.pages().length === 0) await dumpCookiesBeforeClose();
    });
  });
  page.on("close", async () => {
    if (context.pages().length === 0) await dumpCookiesBeforeClose();
  });

  await new Promise<void>((resolve) => {
    context.on("close", () => resolve());
  });

  writeLine({ event: "browser-closed" } as any);
}

/**
 * Reads cookies and storage from the persistent browser profile.
 */
export async function dumpProfile(rawUrl: string, profileDir?: string): Promise<void> {
  const url = ensureProtocol(rawUrl);
  const executablePath = findChromium();
  const userDataDir = getBrowserProfileDir(profileDir);

  if (!fs.existsSync(userDataDir)) {
    writeLine({ event: "profile-data", cookies: [], localStorage: {} } as any);
    return;
  }

  await killChromeForProfile(userDataDir);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath,
    args: STEALTH_ARGS,
    ignoreDefaultArgs: ["--enable-automation"],
  });

  await context.addInitScript(buildStealthInitScript({ seed: url }));

  try {
    const cookies = await context.cookies();
    let localStorage: Record<string, string> = {};
    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      localStorage = await page.evaluate(() => {
        const items: Record<string, string> = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          if (key) items[key] = window.localStorage.getItem(key) ?? "";
        }
        return items;
      });
      await page.close();
    } catch {}

    writeLine({ event: "profile-data", cookies, localStorage } as any);
  } finally {
    await context.close();
  }
}
