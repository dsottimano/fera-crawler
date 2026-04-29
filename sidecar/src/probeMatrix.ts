import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "patchright";
import { crawlPage, ensureChromiumExecutable, getBrowserProfileDir, killChromeForProfile } from "./crawler.js";
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
  // Headed mode = visible Chrome window. Some walls (DataDome, PerimeterX)
  // gate behavioral-detection signals that flip headless→headed even with
  // identical fingerprints. Last-resort row before declaring IP-banned.
  headed: boolean;
  // True → wipe the persistent baseProfileDir before this row runs.
  // Targets the case where Akamai stamped `_abck` with `~-1~` (or
  // Cloudflare invalidated `__cf_bm`) and the poisoned cookie is
  // pre-judging every subsequent request. Wiping resets the bot-score
  // state. Only one row per matrix should set this — multiple wipes is
  // wasted work, and a wipe destroys any other site's login state in
  // the profile.
  wipeBaseProfile: boolean;
}

// Row order: lead with delay escalation (the user's empirically-validated
// #1 lever — most adaptive walls release on slower pacing), then layer
// in profile resets and fingerprint changes. Probe early-exits on the
// first 200, so a typical re-block recovers in 1–2 attempts.
//
// Speed-first ordering: rows 1 → 2 → 3 walk the per-host delay from the
// new app default (2s) up to 10s before any structural changes. Wipe
// runs at the same pace tier the user is most likely to win at (5s),
// not at the cheapest tier — wiping the profile at 1s when 1s is what
// got you blocked is a wasted attempt. The wipe+headed combination row
// captures the user's strongest manual recovery move (memory:
// feedback_block_recovery.md).
export const DEFAULT_MATRIX: ProbeRowConfig[] = [
  { row: 1, stealth: "tier-2", perHostDelayMs: 2000,  warmup: true,  freshProfile: false, residentialUa: false, headed: false, wipeBaseProfile: false },
  { row: 2, stealth: "tier-2", perHostDelayMs: 5000,  warmup: true,  freshProfile: false, residentialUa: false, headed: false, wipeBaseProfile: false },
  { row: 3, stealth: "tier-2", perHostDelayMs: 5000,  warmup: true,  freshProfile: false, residentialUa: false, headed: false, wipeBaseProfile: true  },
  { row: 4, stealth: "tier-2", perHostDelayMs: 10000, warmup: true,  freshProfile: true,  residentialUa: false, headed: false, wipeBaseProfile: false },
  { row: 5, stealth: "tier-2", perHostDelayMs: 10000, warmup: true,  freshProfile: true,  residentialUa: true,  headed: false, wipeBaseProfile: false },
  { row: 6, stealth: "tier-2", perHostDelayMs: 10000, warmup: true,  freshProfile: false, residentialUa: false, headed: true,  wipeBaseProfile: true  },
  { row: 7, stealth: "tier-2", perHostDelayMs: 15000, warmup: true,  freshProfile: true,  residentialUa: true,  headed: true,  wipeBaseProfile: false },
];

function patchesFor(tier: StealthTier) {
  if (tier === "off") return { ...DEFAULT_STEALTH_PATCHES, enabled: false };
  if (tier === "tier-1") {
    return { ...DEFAULT_STEALTH_PATCHES, canvasNoise: false, userAgentData: false };
  }
  return { ...DEFAULT_STEALTH_PATCHES };
}

interface RowOutcome {
  blocked: boolean;
  status: number;
  errored: boolean;
}

async function runRow(
  sampleUrl: string,
  cfg: ProbeRowConfig,
  baseProfileDir: string,
): Promise<RowOutcome> {
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

  // Kill any zombie chromium still holding the SingletonLock on this
  // user-data-dir. Without this, rows 2..N on the shared baseProfileDir
  // (and even cross-row stragglers from a failed launch) hit
  // 'profile already in use' and fail in <100ms before the binary even
  // starts. killChromeForProfile also sleeps 500ms so the OS releases
  // file handles before the next launch.
  await killChromeForProfile(userDataDir);

  // Profile wipe: the strongest single block-busting move. Akamai's
  // `_abck` stamped `~-1~` and Cloudflare's invalidated `__cf_bm`
  // persist across crawls and pre-judge every subsequent request, so
  // wiping the baseProfileDir resets the bot-score state. Only on rows
  // where wipeBaseProfile is set; never on freshProfile rows (those
  // already use a throwaway dir).
  if (cfg.wipeBaseProfile && !cfg.freshProfile) {
    try {
      fs.rmSync(baseProfileDir, { recursive: true, force: true });
      fs.mkdirSync(baseProfileDir, { recursive: true });
    } catch (err) {
      // Best-effort: a leftover lockfile from a process we couldn't
      // kill may block rmSync. Surface it via the row's error string
      // so the user sees why the wipe didn't take effect.
      writeAnyEvent({
        type: "log",
        ts: Date.now(),
        level: "warn",
        msg: "profile wipe failed",
        meta: { row: cfg.row, error: (err as Error).message },
      });
    }
  }

  const executablePath = await ensureChromiumExecutable("probe-matrix");

  let status = 0;
  let title = "";
  let blocked = false;
  let reason: BlockReason | null = null;
  let errorMsg: string | undefined;
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !cfg.headed,
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
    // For fresh-profile rows we're about to rmSync the throwaway dir
    // anyway — no benefit to running killChromeForProfile + its 500ms
    // sleep on it. Saved ~1.5s across rows 5-7 of the matrix. For the
    // shared baseProfileDir we DO need the kill+sleep so the next row's
    // launch doesn't trip on a stale SingletonLock.
    if (cfg.freshProfile && userDataDir !== baseProfileDir) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {}
    } else {
      await killChromeForProfile(userDataDir);
    }
  }

  const finalBlocked = blocked || !!errorMsg;
  writeAnyEvent({
    type: "probe-result",
    ts: Date.now(),
    // Tag every row with the sample URL the matrix was started against so
    // the UI can demux events per probe — defensive belt against the lock
    // ever leaking and two probes running in parallel.
    sampleUrl,
    row: cfg.row,
    config: {
      stealth: cfg.stealth,
      rate: `${cfg.perHostDelayMs}ms`,
      warmup: cfg.warmup,
      freshProfile: cfg.freshProfile,
      residentialUa: cfg.residentialUa,
      headed: cfg.headed,
      wipeBaseProfile: cfg.wipeBaseProfile,
    },
    status,
    title,
    blocked: finalBlocked,
    reason: errorMsg ? "launch_error" : reason,
    error: errorMsg,
    durationMs: Date.now() - started,
  });
  return { blocked: finalBlocked, status, errored: !!errorMsg };
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

  let winningRow: number | null = null;
  for (const cfg of matrix) {
    const outcome = await runRow(sampleUrl, cfg, profileDir);
    // Early exit: first row that returns a real 200 wins. Saves up to ~30s
    // (rows 3-7 are progressively slower at 5-6s each). User can re-probe
    // via the BlockAlert if the wall comes back, which means this row's
    // config wasn't strong enough.
    if (!outcome.blocked) {
      winningRow = cfg.row;
      break;
    }
  }

  writeAnyEvent({
    type: "probe-matrix-complete",
    ts: Date.now(),
    sampleUrl,
    winningRow,
  });
}
