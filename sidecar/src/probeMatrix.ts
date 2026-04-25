import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "patchright";
import { crawlPage, findChromium, getBrowserProfileDir } from "./crawler.js";
import { BlockDetector, hostOf, type BlockReason } from "./blockDetector.js";
import { writeAnyEvent } from "./pipeline.js";
import {
  DEFAULT_STEALTH_PATCHES,
  buildStealthInitScript,
  generateFingerprint,
  buildHeaders,
  buildUserAgent,
  parseUserAgent,
} from "./stealth.js";

// Residential-looking Chrome UA on Windows — stand-in for "real user" fingerprint row.
const RESIDENTIAL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export type StealthTier = "off" | "tier-1" | "tier-2";

export interface ProbeRowConfig {
  row: number;
  stealth: StealthTier;
  perHostDelayMs: number;
  warmup: boolean;
  freshProfile: boolean;
  residentialUa: boolean;
}

export const DEFAULT_MATRIX: ProbeRowConfig[] = [
  { row: 1, stealth: "off",    perHostDelayMs: 500,  warmup: false, freshProfile: false, residentialUa: false },
  { row: 2, stealth: "tier-1", perHostDelayMs: 1000, warmup: true,  freshProfile: false, residentialUa: false },
  { row: 3, stealth: "tier-2", perHostDelayMs: 1000, warmup: true,  freshProfile: false, residentialUa: false },
  { row: 4, stealth: "tier-2", perHostDelayMs: 2000, warmup: true,  freshProfile: false, residentialUa: false },
  { row: 5, stealth: "tier-2", perHostDelayMs: 2000, warmup: true,  freshProfile: true,  residentialUa: false },
  { row: 6, stealth: "tier-2", perHostDelayMs: 2000, warmup: true,  freshProfile: true,  residentialUa: true  },
];

function patchesFor(tier: StealthTier) {
  if (tier === "off") return { ...DEFAULT_STEALTH_PATCHES, enabled: false };
  if (tier === "tier-1") {
    return { ...DEFAULT_STEALTH_PATCHES, canvasNoise: false, userAgentData: false };
  }
  return { ...DEFAULT_STEALTH_PATCHES };
}

async function runRow(
  sampleUrl: string,
  cfg: ProbeRowConfig,
  baseProfileDir: string,
): Promise<void> {
  const started = Date.now();
  const patches = patchesFor(cfg.stealth);
  const ua = cfg.residentialUa ? RESIDENTIAL_UA : undefined;
  const parsedUa = ua ? parseUserAgent(ua) : null;
  const fpOpts = {
    seed: `${sampleUrl}#${cfg.row}`,
    ...(parsedUa
      ? { platform: parsedUa.platform, chromeMajor: parsedUa.chromeMajor, chromeFullVersion: parsedUa.chromeFullVersion }
      : {}),
  };
  const fp = generateFingerprint(fpOpts);
  const stealthEnabled = patches.enabled !== false;
  // buildStealthInitScript derives its own fp from opts — pass the same opts
  // we used for headers so JS-side nav.* matches UA-CH headers + UA string.
  const initScript = stealthEnabled ? buildStealthInitScript({ ...fpOpts, patches }) : null;
  const headers = stealthEnabled && (!ua || parsedUa !== null) ? buildHeaders(fp) : undefined;
  const userAgent = ua || (stealthEnabled ? buildUserAgent(fp) : undefined);

  // Fresh profile: use a throwaway dir so cookies/state don't carry into the row.
  const userDataDir = cfg.freshProfile
    ? path.join(baseProfileDir, "..", `probe-row-${cfg.row}-${Date.now()}`)
    : baseProfileDir;
  if (cfg.freshProfile) fs.mkdirSync(userDataDir, { recursive: true });

  const executablePath = findChromium();

  let status = 0;
  let title = "";
  let blocked = false;
  let reason: BlockReason | null = null;
  let errorMsg: string | undefined;
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(headers ? { extraHTTPHeaders: headers } : {}),
  }).catch((err: Error) => {
    errorMsg = `launch: ${err.message}`;
    return null;
  });

  try {
    if (context) {
      if (initScript) await context.addInitScript(initScript).catch(() => {});

      if (cfg.warmup) {
        try {
          const warmupPage = await context.newPage();
          const origin = new URL(sampleUrl).origin;
          await warmupPage.goto(origin, { waitUntil: "domcontentloaded", timeout: 15000 });
          await new Promise((r) => setTimeout(r, Math.min(cfg.perHostDelayMs, 3000)));
          await warmupPage.close().catch(() => {});
        } catch {
          // Warmup failure is non-fatal.
        }
      }

      // Simulate per-host delay as a pre-request pause.
      await new Promise((r) => setTimeout(r, cfg.perHostDelayMs));

      const page: Page = await context.newPage();
      try {
        const { result } = await crawlPage(page, sampleUrl);
        status = result.status;
        title = result.title;
      } finally {
        await page.close().catch(() => {});
      }

      const detector = new BlockDetector();
      const host = hostOf(sampleUrl);
      const cls = detector.classify({ url: sampleUrl, status, title }, host);
      blocked = cls.blocked;
      reason = cls.reason ?? null;
    }
  } catch (err) {
    errorMsg = `probe: ${(err as Error).message}`;
  } finally {
    if (context) await context.close().catch(() => {});
    if (cfg.freshProfile && userDataDir !== baseProfileDir) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {}
    }
  }

  writeAnyEvent({
    type: "probe-result",
    ts: Date.now(),
    row: cfg.row,
    config: {
      stealth: cfg.stealth,
      rate: `${cfg.perHostDelayMs}ms`,
      warmup: cfg.warmup,
      freshProfile: cfg.freshProfile,
      residentialUa: cfg.residentialUa,
    },
    status,
    title,
    blocked: blocked || !!errorMsg,
    reason: errorMsg ? "launch_error" : reason,
    error: errorMsg,
    durationMs: Date.now() - started,
  });
}

export async function runProbeMatrix(
  sampleUrl: string,
  baseProfileDir?: string,
  matrix: ProbeRowConfig[] = DEFAULT_MATRIX,
): Promise<void> {
  const profileDir = getBrowserProfileDir(baseProfileDir);

  writeAnyEvent({
    type: "probe-matrix-start",
    ts: Date.now(),
    sampleUrl,
    rows: matrix.length,
  });

  for (const cfg of matrix) {
    await runRow(sampleUrl, cfg, profileDir);
  }

  writeAnyEvent({
    type: "probe-matrix-complete",
    ts: Date.now(),
    sampleUrl,
  });
}
