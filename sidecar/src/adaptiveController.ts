import type { PerHostRateLimiter } from "./rate-limiter.js";
import type { PerHostStates } from "./perHostState.js";
import type { Classification } from "./responseClassifier.js";

const FLOOR_MS = 250;
const CEIL_MS = 15000;
const MD_MULTIPLIER = 1.6;
const AI_STEP_MS = 100;
const CLEAN_STREAK_THRESHOLD = 200;
const SINCE_BLOCK_THRESHOLD_MS = 60_000;
const CONSECUTIVE_403_THRESHOLD = 10;
const CONSECUTIVE_403_WINDOW_MS = 60_000;
const CEILING_SATURATED_MS = 5 * 60_000;
const CEILING_BLOCK_RATE_THRESHOLD = 0.2;
const REPROBE_COOLDOWN_MS = 5 * 60_000;
const STATE_EMIT_DEBOUNCE_MS = 1000;

export type ControllerEvent =
  | {
      type: "controller-state";
      ts: number;
      host: string;
      delayMs: number;
      multiplier: number;
      blockRate: number;
      classification: Classification;
      action: "step-up" | "step-down" | "hold";
    }
  | {
      type: "re-probe-requested";
      ts: number;
      host: string;
      reason: "403-burst" | "ceiling-saturated";
      sampleUrl: string;
    };

export interface AdaptiveControllerOpts {
  rateLimiter: PerHostRateLimiter;
  states: PerHostStates;
  delayMinMs: number;
  onEvent: (e: ControllerEvent) => void;
}

interface PerHostCtl {
  ceilingSinceMonoMs: number | null;
  consec403StartMonoMs: number | null;
  lastReprobeMonoMs: number | null;
  lastEmitMonoMs: number;
}

function isBlocked(c: Classification): boolean {
  return c === "blocked-status:403"
    || c === "blocked-status:429"
    || c === "blocked-status:503"
    || c === "blocked-status:5xx"
    || c === "blocked-content"
    || c === "cloaked";
}

function monoNowMs(): number {
  return performance.now();
}

export class AdaptiveController {
  private rl: PerHostRateLimiter;
  private states: PerHostStates;
  private delayMinMs: number;
  private onEvent: (e: ControllerEvent) => void;
  private floorMult: number;
  private ceilMult: number;
  private aiStepMult: number;
  private ctl = new Map<string, PerHostCtl>();

  constructor(opts: AdaptiveControllerOpts) {
    this.rl = opts.rateLimiter;
    this.states = opts.states;
    this.delayMinMs = opts.delayMinMs;
    this.onEvent = opts.onEvent;
    this.floorMult = FLOOR_MS / opts.delayMinMs;
    this.ceilMult = CEIL_MS / opts.delayMinMs;
    this.aiStepMult = AI_STEP_MS / opts.delayMinMs;
  }

  tick(
    host: string,
    classification: Classification,
    snap: { url: string; bodyBytes: number; internalLinks: number },
  ): void {
    const ctl = this.touchCtl(host);

    let action: "step-up" | "step-down" | "hold" = "hold";

    if (isBlocked(classification)) {
      const cur = this.rl.getMultiplier(host);
      const next = Math.min(this.ceilMult, cur * MD_MULTIPLIER);
      this.rl.setMultiplier(host, next);
      action = "step-up";
    } else if (
      classification === "ok" &&
      this.states.cleanStreak(host) >= CLEAN_STREAK_THRESHOLD &&
      this.states.sinceLastBlockMs(host) >= SINCE_BLOCK_THRESHOLD_MS
    ) {
      const cur = this.rl.getMultiplier(host);
      const next = Math.max(this.floorMult, cur - this.aiStepMult);
      if (next !== cur) {
        this.rl.setMultiplier(host, next);
        this.states.resetCleanStreak(host);
        action = "step-down";
      }
    }

    this.maybeReprobe(host, classification, snap.url, ctl);
    this.maybeEmitState(host, classification, action, ctl);
  }

  private maybeReprobe(host: string, classification: Classification, sampleUrl: string, ctl: PerHostCtl): void {
    const nowMono = monoNowMs();
    if (ctl.lastReprobeMonoMs !== null && nowMono - ctl.lastReprobeMonoMs < REPROBE_COOLDOWN_MS) return;

    if (classification === "blocked-status:403") {
      if (ctl.consec403StartMonoMs === null) ctl.consec403StartMonoMs = nowMono;
      const consec = this.states.consecutive403(host);
      if (
        consec >= CONSECUTIVE_403_THRESHOLD &&
        nowMono - ctl.consec403StartMonoMs <= CONSECUTIVE_403_WINDOW_MS
      ) {
        this.fireReprobe(host, "403-burst", sampleUrl, ctl);
        return;
      }
    } else {
      ctl.consec403StartMonoMs = null;
    }

    const atCeiling = this.rl.getMultiplier(host) >= this.ceilMult - 1e-9;
    if (atCeiling) {
      if (ctl.ceilingSinceMonoMs === null) ctl.ceilingSinceMonoMs = nowMono;
      if (
        nowMono - ctl.ceilingSinceMonoMs >= CEILING_SATURATED_MS &&
        this.states.blockRate(host) > CEILING_BLOCK_RATE_THRESHOLD
      ) {
        this.fireReprobe(host, "ceiling-saturated", sampleUrl, ctl);
      }
    } else {
      ctl.ceilingSinceMonoMs = null;
    }
  }

  private fireReprobe(
    host: string,
    reason: "403-burst" | "ceiling-saturated",
    sampleUrl: string,
    ctl: PerHostCtl,
  ): void {
    ctl.lastReprobeMonoMs = monoNowMs();
    this.onEvent({ type: "re-probe-requested", ts: Date.now(), host, reason, sampleUrl });
  }

  private maybeEmitState(
    host: string,
    classification: Classification,
    action: "step-up" | "step-down" | "hold",
    ctl: PerHostCtl,
  ): void {
    const nowMono = monoNowMs();
    const force = action !== "hold";
    if (!force && nowMono - ctl.lastEmitMonoMs < STATE_EMIT_DEBOUNCE_MS) return;
    ctl.lastEmitMonoMs = nowMono;
    const mult = this.rl.getMultiplier(host);
    this.onEvent({
      type: "controller-state",
      ts: Date.now(),
      host,
      delayMs: Math.round(this.delayMinMs * mult),
      multiplier: mult,
      blockRate: this.states.blockRate(host),
      classification,
      action,
    });
  }

  private touchCtl(host: string): PerHostCtl {
    let c = this.ctl.get(host);
    if (!c) {
      c = {
        ceilingSinceMonoMs: null,
        consec403StartMonoMs: null,
        lastReprobeMonoMs: null,
        lastEmitMonoMs: -Infinity,
      };
      this.ctl.set(host, c);
    }
    return c;
  }
}
