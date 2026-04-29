import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "patchright";
import { ensureProtocol, ensureChromiumExecutable, STEALTH_ARGS } from "./crawler.js";
import {
  DEFAULT_STEALTH_PATCHES,
  buildHeaders,
  buildStealthInitScript,
  buildUserAgent,
  generateFingerprint,
  type StealthPatchConfig,
} from "./stealth.js";

export interface ProbeRung {
  label: string;
  stealth: boolean;
  headless: boolean;
  sessionWarmup: boolean;
  perHostDelay: number;
  perHostConcurrency: number;
  concurrency: number;
}

export type QualityFlag =
  | "fake-200"
  | "bot-verdict-visible"
  | "thin-body-lt5kb"
  | "low-content-lt30w"
  | "no-seo-all3"
  | "cloaked-5pct"
  | "zero-outlinks";

export interface QualitySignals {
  score: number; // 0-100
  flags: QualityFlag[];
  bodyBytes: number;
  wordCount: number;
  title: string;
  h1: string;
  outlinkCount: number;
  passes: boolean;
}

export interface SpeedSignals {
  firstMs: number;
  sampleMs: number[]; // successful samples only
  failedSamples: number; // count of samples that errored
  medianMs: number | null; // null if no samples succeeded
}

export interface ProbeAttempt {
  step: number;
  label: string;
  config: Record<string, unknown>;
  status: number | null;
  ok: boolean; // status in 2xx/3xx
  blocked: boolean; // 403/429/503
  ms: number; // first-page goto ms (same as speed.firstMs when available)
  quality: QualitySignals | null;
  speed: SpeedSignals | null;
  passesAllGates: boolean;
  error?: string;
}

export interface ProbeRanking {
  label: string;
  firstMs: number;
  medianMs: number | null;
  qualityScore: number;
  passesAllGates: boolean;
}

export interface ProbeResult {
  url: string;
  winningConfig: Record<string, unknown> | null;
  winningLabel: string | null;
  attempts: ProbeAttempt[];
  ranking: ProbeRanking[];
  probedAt: string;
}

export const PROBE_LADDER: ProbeRung[] = [
  { label: "stealth-off-headless",  stealth: false, headless: true,  sessionWarmup: false, perHostDelay: 500,  perHostConcurrency: 2, concurrency: 5 },
  { label: "stealth-on-headless",   stealth: true,  headless: true,  sessionWarmup: false, perHostDelay: 500,  perHostConcurrency: 2, concurrency: 5 },
  { label: "stealth-on-warmup",     stealth: true,  headless: true,  sessionWarmup: true,  perHostDelay: 500,  perHostConcurrency: 2, concurrency: 5 },
  { label: "stealth-on-slow",       stealth: true,  headless: true,  sessionWarmup: true,  perHostDelay: 1500, perHostConcurrency: 1, concurrency: 1 },
  { label: "stealth-on-headed",     stealth: true,  headless: false, sessionWarmup: false, perHostDelay: 500,  perHostConcurrency: 2, concurrency: 5 },
];

const SAMPLE_SIZE = 5;
const SAMPLE_TIMEOUT_MS = 20000;
const FIRST_NAV_TIMEOUT_MS = 20000;
// Structural block pages — title/h1 says "Access Denied", etc. Fires at
// gate level on title/h1 only to avoid false-positiving on articles.
const BLOCK_PATTERN = /access denied|forbidden|cloudflare|captcha|robot check|enable javascript|unsupported browser|are you (a )?human|just a moment/i;
// Visible body text that indicates the page IS an anti-bot challenge
// (not just mentioning one). Tight on purpose — these phrases don't
// appear in legitimate content.
const BOT_VERDICT_PATTERN = /checking\s+your\s+browser\s+before\s+accessing|please\s+(?:verify|prove)\s+you(?:'re|\s+are)\s+(?:a\s+)?human|unusual\s+traffic\s+from\s+your\s+(?:computer|network)|our\s+systems\s+have\s+detected\s+unusual|complete\s+the\s+security\s+check|click\s+(?:the\s+box\s+)?(?:below\s+)?to\s+(?:verify|prove|confirm)\s+you|just\s+a\s+moment\b|security\s+check\s+to\s+access|bot\s+behavior\s+detected|automation\s+detected/i;

function rungToConfig(r: ProbeRung): Record<string, unknown> {
  return {
    stealthConfig: { enabled: r.stealth },
    headless: r.headless,
    sessionWarmup: r.sessionWarmup,
    perHostDelay: r.perHostDelay,
    perHostConcurrency: r.perHostConcurrency,
    concurrency: r.concurrency,
  };
}

function cleanError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(new RegExp("\\u001b\\[[0-9;]*m", "g"), "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function assessQuality(page: Page, url: string): Promise<QualitySignals> {
  const data = await page.evaluate((pageUrl: string) => {
    const pageOrigin = (() => {
      try { return new URL(pageUrl).origin; } catch { return ""; }
    })();
    const title = (document.title || "").trim();
    const h1Elem = document.querySelector("h1");
    const h1 = h1Elem ? (h1Elem.textContent || "").trim() : "";
    const bodyText = document.body ? document.body.innerText || "" : "";
    const wordCount = bodyText.trim().split(/\s+/).filter(Boolean).length;
    const bodyBytes = (document.documentElement.outerHTML || "").length;

    const metaDesc = !!document.querySelector('meta[name="description"][content]');
    const ogTitle = !!document.querySelector('meta[property="og:title"][content]');
    const canonical = !!document.querySelector('link[rel="canonical"][href]');

    const anchors = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
    const internal = anchors
      .map((a) => a.href)
      .filter((h) => h.startsWith("http"))
      .filter((h) => {
        try { return new URL(h).origin === pageOrigin; } catch { return false; }
      });

    return {
      title, h1, wordCount, bodyBytes,
      // Cap visible text so we don't bloat the IPC. 20KB is plenty for
      // challenge-phrase detection; challenge pages are always tiny.
      bodyText: bodyText.slice(0, 20000),
      metaDesc, ogTitle, canonical, outlinkCount: internal.length,
    };
  }, url);

  const flags: QualityFlag[] = [];
  if (BLOCK_PATTERN.test(data.title) || BLOCK_PATTERN.test(data.h1)) flags.push("fake-200");
  if (BOT_VERDICT_PATTERN.test(data.bodyText)) flags.push("bot-verdict-visible");
  if (data.bodyBytes < 5000) flags.push("thin-body-lt5kb");
  if (data.wordCount < 30) flags.push("low-content-lt30w");
  if (!data.metaDesc && !data.ogTitle && !data.canonical) flags.push("no-seo-all3");
  if (data.outlinkCount === 0) flags.push("zero-outlinks");

  let score = 100;
  if (flags.includes("fake-200")) score -= 70;
  if (flags.includes("bot-verdict-visible")) score -= 70;
  if (flags.includes("thin-body-lt5kb")) score -= 15;
  if (flags.includes("low-content-lt30w")) score -= 15;
  if (flags.includes("no-seo-all3")) score -= 10;
  if (flags.includes("zero-outlinks")) score -= 10;

  const fatal = flags.includes("fake-200") || flags.includes("bot-verdict-visible");
  const softCount = flags.filter(
    (f) => f !== "fake-200" && f !== "bot-verdict-visible" && f !== "cloaked-5pct",
  ).length;
  const passes = !fatal && softCount <= 1;

  return {
    score: Math.max(0, score),
    flags,
    bodyBytes: data.bodyBytes,
    wordCount: data.wordCount,
    title: data.title.slice(0, 160),
    h1: data.h1.slice(0, 160),
    outlinkCount: data.outlinkCount,
    passes,
  };
}

async function collectSampleUrls(page: Page, startUrl: string): Promise<string[]> {
  const origin = (() => { try { return new URL(startUrl).origin; } catch { return ""; } })();
  if (!origin) return [];
  const links = await page.evaluate((pageOrigin: string) => {
    const anchors = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const a of anchors) {
      const href = a.href;
      if (!href.startsWith("http")) continue;
      let u: URL;
      try { u = new URL(href); } catch { continue; }
      if (u.origin !== pageOrigin) continue;
      u.hash = "";
      const clean = u.toString();
      if (seen.has(clean)) continue;
      seen.add(clean);
      out.push(clean);
    }
    return out;
  }, origin);

  return shuffle(links).filter((l) => l !== startUrl).slice(0, SAMPLE_SIZE);
}

async function sampleSpeed(page: Page, urls: string[]): Promise<SpeedSignals["sampleMs"] & { failed: number }> {
  const successful: number[] = [];
  let failed = 0;
  for (const u of urls) {
    const t = Date.now();
    try {
      await page.goto(u, { timeout: SAMPLE_TIMEOUT_MS, waitUntil: "domcontentloaded" });
      successful.push(Date.now() - t);
    } catch {
      failed += 1;
    }
  }
  return Object.assign(successful, { failed });
}

async function tryRung(url: string, step: number, rung: ProbeRung): Promise<ProbeAttempt> {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "fera-probe-"));
  const executablePath = await ensureChromiumExecutable("probe-config");
  const runStart = Date.now();

  const patches: StealthPatchConfig = { ...DEFAULT_STEALTH_PATCHES, enabled: rung.stealth };
  const fp = generateFingerprint({ seed: url });
  const ua = rung.stealth ? buildUserAgent(fp) : undefined;
  const headers = rung.stealth ? buildHeaders(fp) : undefined;

  const launchOpts: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless: rung.headless,
    ...(executablePath ? { executablePath } : {}),
    args: rung.headless ? STEALTH_ARGS : [...STEALTH_ARGS, "--start-maximized"],
    ignoreDefaultArgs: ["--enable-automation"],
    ...((!rung.headless || !rung.stealth) ? { viewport: null } : {}),
    ...(ua ? { userAgent: ua } : {}),
    ...(headers ? { extraHTTPHeaders: headers } : {}),
  };

  const config = rungToConfig(rung);
  let ctx: BrowserContext | null = null;

  try {
    ctx = await chromium.launchPersistentContext(profileDir, launchOpts);
    if (rung.stealth) {
      await ctx.addInitScript(buildStealthInitScript({ seed: url, patches }));
    }

    if (rung.sessionWarmup) {
      const origin = new URL(url).origin;
      const warmPage = await ctx.newPage();
      try { await warmPage.goto(origin, { timeout: 10000, waitUntil: "domcontentloaded" }); } catch {}
      await warmPage.close().catch(() => {});
    }

    const page = await ctx.newPage();
    const firstStart = Date.now();
    const resp = await page.goto(url, { timeout: FIRST_NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    const firstMs = Date.now() - firstStart;
    const status = resp?.status() ?? null;
    const statusOk = !!(status && status >= 200 && status < 400);
    const blocked = !!(status && (status === 403 || status === 429 || status === 503));

    let quality: QualitySignals | null = null;
    let speed: SpeedSignals | null = null;

    if (statusOk) {
      // Give JS-rendered challenge pages a chance to swap in their verdict
      // text before we scan. Cheap (1.5s × 5 rungs ≈ 7.5s) and catches
      // Cloudflare/Turnstile/pixelscan-style client-side detectors.
      await page.waitForTimeout(1500);
      quality = await assessQuality(page, url);
      if (quality.passes) {
        const sampleUrls = await collectSampleUrls(page, url);
        const samples = await sampleSpeed(page, sampleUrls);
        speed = {
          firstMs,
          sampleMs: Array.from(samples),
          failedSamples: samples.failed,
          medianMs: median(samples as number[]),
        };
      } else {
        speed = { firstMs, sampleMs: [], failedSamples: 0, medianMs: null };
      }
    }

    const passesAllGates = statusOk && !!quality?.passes;

    return {
      step,
      label: rung.label,
      config,
      status,
      ok: statusOk,
      blocked,
      ms: Date.now() - runStart,
      quality,
      speed,
      passesAllGates,
    };
  } catch (err: unknown) {
    return {
      step,
      label: rung.label,
      config,
      status: null,
      ok: false,
      blocked: false,
      ms: Date.now() - runStart,
      quality: null,
      speed: null,
      passesAllGates: false,
      error: cleanError(err),
    };
  } finally {
    try { await ctx?.close(); } catch {}
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }
}

// After all rungs run, flag rungs with suspiciously identical body sizes
// across differently-behaving stealth tiers (fingerprint-based cloaking).
function detectCloaking(attempts: ProbeAttempt[]): void {
  const sizes = attempts
    .filter((a) => a.quality && a.status && a.status < 400)
    .map((a) => a.quality!.bodyBytes);
  if (sizes.length < 2) return;
  const min = Math.min(...sizes);
  const max = Math.max(...sizes);
  // All passing rungs within 5% of each other — uniform cloaked response or
  // just a stable site. Only a soft flag, doesn't fail the gate on its own.
  if (min > 0 && (max - min) / max < 0.05) return; // identical = fine (most sites)
  // If a rung's body is within 5% of a BLOCKED rung's body, it's likely cloaked.
  const blockedSizes = attempts
    .filter((a) => a.blocked && a.quality)
    .map((a) => a.quality!.bodyBytes);
  if (!blockedSizes.length) return;
  for (const a of attempts) {
    if (!a.quality || !a.ok) continue;
    for (const bs of blockedSizes) {
      if (bs > 0 && Math.abs(a.quality.bodyBytes - bs) / bs < 0.05) {
        if (!a.quality.flags.includes("cloaked-5pct")) a.quality.flags.push("cloaked-5pct");
        a.quality.score = Math.max(0, a.quality.score - 40);
        a.quality.passes = false;
        a.passesAllGates = false;
      }
    }
  }
}

export async function probeConfig(
  rawUrl: string,
  opts?: { headedAllowed?: boolean },
): Promise<ProbeResult> {
  const url = ensureProtocol(rawUrl);
  const attempts: ProbeAttempt[] = [];
  const headedAllowed = opts?.headedAllowed ?? !!process.env.DISPLAY;

  for (let i = 0; i < PROBE_LADDER.length; i++) {
    const rung = PROBE_LADDER[i];
    if (!rung.headless && !headedAllowed) {
      attempts.push({
        step: i,
        label: rung.label,
        config: rungToConfig(rung),
        status: null,
        ok: false,
        blocked: false,
        ms: 0,
        quality: null,
        speed: null,
        passesAllGates: false,
        error: "headed rung skipped (no DISPLAY)",
      });
      continue;
    }
    attempts.push(await tryRung(url, i, rung));
  }

  detectCloaking(attempts);

  const ranking: ProbeRanking[] = attempts.map((a) => ({
    label: a.label,
    firstMs: a.speed?.firstMs ?? a.ms,
    medianMs: a.speed?.medianMs ?? null,
    qualityScore: a.quality?.score ?? 0,
    passesAllGates: a.passesAllGates,
  }));

  // Winner = passesAllGates rung with lowest medianMs (fall back to firstMs).
  const eligible = attempts.filter((a) => a.passesAllGates);
  eligible.sort((a, b) => {
    const am = a.speed?.medianMs ?? Number.POSITIVE_INFINITY;
    const bm = b.speed?.medianMs ?? Number.POSITIVE_INFINITY;
    if (am !== bm) return am - bm;
    return (a.speed?.firstMs ?? a.ms) - (b.speed?.firstMs ?? b.ms);
  });
  const winner = eligible[0] ?? null;

  return {
    url,
    winningConfig: winner?.config ?? null,
    winningLabel: winner?.label ?? null,
    attempts,
    ranking,
    probedAt: new Date().toISOString(),
  };
}
