// Per-host block detection. Trips when a rolling window of the last 15
// responses for a host contains >=10 "blocked" signals. Hard blocks
// (403/429/5xx) and soft blocks (block-phrase title, or repeated title
// across distinct URLs) are both counted.
//
// After a trip, an auto-cooldown timer is scheduled. When it fires, the
// gate clears, parked URLs go back into the queue, and the host gets
// another shot. Consecutive trips back off exponentially. Once the
// backoff ladder is exhausted, the gate stays set until a user un-gates
// (so the user is asked to intervene rather than spinning forever).

const WINDOW_SIZE = 15;
const TRIP_THRESHOLD = 10;
// Fast-trip: if the END of the window is N consecutively-blocked entries,
// park the host immediately even though TRIP_THRESHOLD isn't met. Catches
// the case where soft-only blocks stream in (e.g. 5 same-titled "Access
// Blocked" pages with HTTP 200) — the rolling-window count rises slowly
// but the consecutive run is a clear, strong signal that doesn't deserve
// 5 more wasted requests of waiting.
const CONSECUTIVE_TRIP_THRESHOLD = 5;
const SOFT_TITLE_REPEAT_THRESHOLD = 3;

// Phrases that show up on bot-wall interstitials regardless of the upstream
// HTTP status. Walls increasingly serve "you've been blocked" pages with
// 200 OK so vanilla status-code heuristics miss them entirely. Keep this
// list matching only HIGH-CONFIDENCE phrases — false positives gate hosts
// that are actually fine.
const BLOCK_PHRASE_RE =
  /access denied|attention required|just a moment|verify you are human|are you a robot|pardon our interruption|request unsuccessful|you have been blocked|you've been blocked|sorry,?\s+you have been blocked|security check|cloudflare to restrict access|please verify you are a human|bot detected|access to this page has been denied|website is using a security service to protect itself/i;

// 60s → 2min → 4min, then give up.
export const DEFAULT_COOLDOWNS_MS = [60_000, 120_000, 240_000];

export type BlockReason =
  | "status_403"
  | "status_429"
  | "status_5xx"
  | "soft_title_phrase"
  | "soft_title_repeat";

interface WindowEntry {
  blocked: boolean;
  reason?: BlockReason;
  url: string;
}

interface HostState {
  window: WindowEntry[];
  titleToUrls: Map<string, Set<string>>;
  gated: boolean;
  cooldownTimer: ReturnType<typeof setTimeout> | null;
  cooldownAttempts: number;
}

export interface BlockDetectedPayload {
  type: "block-detected";
  ts: number;
  host: string;
  reasons: Record<string, number>;
  stats: { blocked: number; window: number };
  sampleUrls: string[];
  cooldownMs: number | null;
  attempt: number;
}

export interface ObservedResponse {
  url: string;
  status: number;
  title?: string;
}

export interface ClassifyResult {
  blocked: boolean;
  reason?: BlockReason;
}

export interface BlockDetectorOpts {
  // Called when a cooldown timer fires and the gate auto-clears. The
  // callback should requeue any URLs parked while the host was gated.
  onAutoClear?: (host: string) => void;
  // Override the default backoff ladder. Pass [] to disable cooldowns
  // entirely (gate stays set until clearGate). Mainly for tests.
  cooldownsMs?: number[];
}

export class BlockDetector {
  private hosts = new Map<string, HostState>();
  private onAutoClear?: (host: string) => void;
  private cooldownsMs: number[];

  constructor(opts: BlockDetectorOpts = {}) {
    this.onAutoClear = opts.onAutoClear;
    this.cooldownsMs = opts.cooldownsMs ?? DEFAULT_COOLDOWNS_MS;
  }

  isGated(host: string): boolean {
    return this.hosts.get(host)?.gated === true;
  }

  // User-triggered reset: full clear, cancel any pending cooldown, reset
  // backoff. After this, the host starts from a clean slate.
  clearGate(host: string): void {
    const s = this.hosts.get(host);
    if (!s) return;
    s.gated = false;
    s.window.length = 0;
    s.titleToUrls.clear();
    s.cooldownAttempts = 0;
    if (s.cooldownTimer) {
      clearTimeout(s.cooldownTimer);
      s.cooldownTimer = null;
    }
  }

  // For introspection / testing.
  cooldownAttempts(host: string): number {
    return this.hosts.get(host)?.cooldownAttempts ?? 0;
  }

  classify(resp: ObservedResponse, host: string): ClassifyResult {
    const { status, title = "" } = resp;

    if (status === 403) return { blocked: true, reason: "status_403" };
    if (status === 429) return { blocked: true, reason: "status_429" };
    if (status >= 500 && status < 600) return { blocked: true, reason: "status_5xx" };

    if (title && BLOCK_PHRASE_RE.test(title)) {
      return { blocked: true, reason: "soft_title_phrase" };
    }

    if (status === 200 && title) {
      const urls = this.getState(host).titleToUrls.get(title);
      if (urls && urls.size >= SOFT_TITLE_REPEAT_THRESHOLD) {
        return { blocked: true, reason: "soft_title_repeat" };
      }
    }

    return { blocked: false };
  }

  // Records a response; returns a trip payload if this call tripped the gate,
  // null otherwise. Caller is responsible for emitting the event.
  record(resp: ObservedResponse, host: string): BlockDetectedPayload | null {
    const state = this.getState(host);

    if (resp.title && resp.status === 200) {
      let set = state.titleToUrls.get(resp.title);
      if (!set) {
        set = new Set();
        state.titleToUrls.set(resp.title, set);
      }
      set.add(resp.url);
    }

    const { blocked, reason } = this.classify(resp, host);
    state.window.push({ blocked, reason, url: resp.url });
    if (state.window.length > WINDOW_SIZE) state.window.shift();

    if (state.gated) return null;

    const blockedCount = state.window.filter((w) => w.blocked).length;
    const consecutiveTail = countTrailingBlocks(state.window);
    const tripped =
      blockedCount >= TRIP_THRESHOLD ||
      consecutiveTail >= CONSECUTIVE_TRIP_THRESHOLD;
    if (!tripped) return null;

    state.gated = true;
    const cooldownMs = this.scheduleCooldownIfEligible(host, state);
    return this.buildPayload(host, state, cooldownMs);
  }

  private scheduleCooldownIfEligible(host: string, state: HostState): number | null {
    // Backoff ladder exhausted — gate stays set until user clears it.
    if (state.cooldownAttempts >= this.cooldownsMs.length) return null;

    const delay = this.cooldownsMs[state.cooldownAttempts];
    state.cooldownAttempts++;
    state.cooldownTimer = setTimeout(() => {
      state.cooldownTimer = null;
      // Auto-clear — keeps cooldownAttempts so the NEXT trip uses the next
      // step on the backoff ladder. Only user-initiated clearGate resets it.
      state.gated = false;
      state.window.length = 0;
      state.titleToUrls.clear();
      this.onAutoClear?.(host);
    }, delay);
    // Don't keep the event loop alive on this timer alone (lets the process
    // exit cleanly when the crawl finishes).
    if (typeof state.cooldownTimer === "object" && state.cooldownTimer && "unref" in state.cooldownTimer) {
      (state.cooldownTimer as { unref?: () => void }).unref?.();
    }
    return delay;
  }

  private buildPayload(host: string, state: HostState, cooldownMs: number | null): BlockDetectedPayload {
    const reasons: Record<string, number> = {};
    const sampleUrls: string[] = [];
    for (const entry of state.window) {
      if (!entry.blocked) continue;
      if (entry.reason) reasons[entry.reason] = (reasons[entry.reason] ?? 0) + 1;
      sampleUrls.push(entry.url);
    }
    return {
      type: "block-detected",
      ts: Date.now(),
      host,
      reasons,
      stats: {
        blocked: state.window.filter((w) => w.blocked).length,
        window: state.window.length,
      },
      sampleUrls: sampleUrls.slice(-5),
      cooldownMs,
      attempt: state.cooldownAttempts,
    };
  }

  private getState(host: string): HostState {
    let s = this.hosts.get(host);
    if (!s) {
      s = {
        window: [],
        titleToUrls: new Map(),
        gated: false,
        cooldownTimer: null,
        cooldownAttempts: 0,
      };
      this.hosts.set(host, s);
    }
    return s;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// Length of the trailing run of `blocked: true` entries in the window.
// Used by the consecutive-trip fast path so a tight cluster of soft-only
// blocks can park a host without waiting for 10/15 to accumulate.
function countTrailingBlocks(window: WindowEntry[]): number {
  let n = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    if (!window[i].blocked) break;
    n++;
  }
  return n;
}
