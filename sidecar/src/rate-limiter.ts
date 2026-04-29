/**
 * Per-host rate limiter.
 *
 * Goals:
 *   1. No more than `maxConcurrency` concurrent in-flight requests per host.
 *   2. No less than `delayMs` elapsed time between successive request-STARTS
 *      to the same host.
 *
 * Both limits are enforced independently. A caller wraps every navigation
 * with `await rl.acquire(host)` + `rl.release(host)` in a try/finally.
 *
 * Rationale: global concurrency/delay is blunt. Real crawlers that survive
 * long against adaptive rate-limit walls gate per-origin, because the
 * crawler's aggregate RPS doesn't matter — only the RPS any one host sees.
 */

interface HostState {
  lastRequestStartMs: number;
  inFlight: number;
  /** FIFO list of resolvers waiting for a concurrency slot. */
  waiters: Array<() => void>;
  /**
   * Per-host delay multiplier. Starts at 1.0; bumped to 2.0/4.0/etc. by
   * `bumpDelay(host)` whenever the block detector trips that host. The
   * effective range becomes `[delayMin × mult, delayMax × mult]`.
   * Slows misbehaving hosts without affecting siblings — a list-mode
   * crawl across many hosts shouldn't tar the well-behaved ones with
   * the bot-walled host's slowdown.
   */
  delayMultiplier: number;
}

export interface PerHostRateLimiterOpts {
  /**
   * Minimum ms between successive request starts to the same host.
   * If delayMaxMs > delayMinMs, each request samples a fresh uniform random
   * delay from [min, max] — this defeats interval-regularity bot detectors
   * (DataDome, PerimeterX, Akamai's adaptive layer all watch for "exact
   * 1000ms between requests" as a bot signal). Mean stays the same so
   * throughput is unchanged.
   */
  delayMinMs: number;
  /**
   * Maximum ms (inclusive) for the per-request delay. If undefined or
   * <= delayMinMs, jitter is disabled and the limiter behaves as fixed
   * delayMinMs (preserves old single-value behavior).
   */
  delayMaxMs?: number;
  /** Maximum concurrent in-flight requests per host. */
  maxConcurrency: number;
}

export class PerHostRateLimiter {
  private states = new Map<string, HostState>();
  public readonly delayMinMs: number;
  public readonly delayMaxMs: number;
  public readonly maxConcurrency: number;

  constructor(opts: PerHostRateLimiterOpts) {
    if (opts.delayMinMs < 0) throw new Error("delayMinMs must be >= 0");
    if (opts.maxConcurrency < 1) throw new Error("maxConcurrency must be >= 1");
    this.delayMinMs = opts.delayMinMs;
    this.delayMaxMs = opts.delayMaxMs !== undefined && opts.delayMaxMs > opts.delayMinMs
      ? opts.delayMaxMs
      : opts.delayMinMs;
    this.maxConcurrency = opts.maxConcurrency;
  }

  /** Average delay (mean of the uniform range). Used for telemetry / display. */
  get delayMs(): number {
    return Math.round((this.delayMinMs + this.delayMaxMs) / 2);
  }

  /** Pick the next delay for a request — fresh draw per call. */
  private nextDelayMs(mult: number): number {
    const min = Math.round(this.delayMinMs * mult);
    const max = Math.round(this.delayMaxMs * mult);
    if (max === min) return min;
    const span = max - min;
    return min + Math.floor(Math.random() * (span + 1));
  }

  private getState(host: string): HostState {
    let s = this.states.get(host);
    if (!s) {
      s = { lastRequestStartMs: 0, inFlight: 0, waiters: [], delayMultiplier: 1 };
      this.states.set(host, s);
    }
    return s;
  }

  /**
   * Double the delay multiplier for `host`. Called when the block
   * detector trips that host — slowing the next round of attempts is
   * the simplest and most effective recovery: walls that gate on RPS
   * release the gate when RPS drops, and slowing per-host doesn't
   * affect siblings on a list-mode crawl. Cap at 8x to bound the worst
   * case (default 2000ms→16000ms; user can hard-stop the crawl if
   * that's too slow).
   */
  bumpDelay(host: string): { multiplier: number; newDelayMinMs: number; newDelayMaxMs: number } {
    const state = this.getState(host);
    state.delayMultiplier = Math.min(state.delayMultiplier * 2, 8);
    return {
      multiplier: state.delayMultiplier,
      newDelayMinMs: Math.round(this.delayMinMs * state.delayMultiplier),
      newDelayMaxMs: Math.round(this.delayMaxMs * state.delayMultiplier),
    };
  }

  /**
   * Wait until it's OK to start a request against `host`. Callers MUST
   * call `release(host)` after their request completes, regardless of
   * success. Use try/finally.
   */
  async acquire(host: string): Promise<void> {
    const state = this.getState(host);

    // Gate 1: concurrency slot.
    while (state.inFlight >= this.maxConcurrency) {
      await new Promise<void>((resolve) => state.waiters.push(resolve));
    }
    state.inFlight++;

    // Gate 2: per-request randomized delay since last request start. Fresh
    // draw each acquire — never per-session, which would leak the seed.
    // Multiplier is per-host so a slow misbehaving host doesn't tar its
    // well-behaved siblings.
    const delay = this.nextDelayMs(state.delayMultiplier);
    if (delay > 0) {
      const elapsed = Date.now() - state.lastRequestStartMs;
      if (elapsed < delay) {
        await sleep(delay - elapsed);
      }
    }
    state.lastRequestStartMs = Date.now();
  }

  release(host: string): void {
    const state = this.states.get(host);
    if (!state || state.inFlight === 0) return;
    state.inFlight--;
    const next = state.waiters.shift();
    if (next) next();
  }

  /** Expose current state for debug/telemetry. */
  snapshot(): Record<string, { inFlight: number; waiters: number }> {
    const out: Record<string, { inFlight: number; waiters: number }> = {};
    for (const [host, s] of this.states) {
      out[host] = { inFlight: s.inFlight, waiters: s.waiters.length };
    }
    return out;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Parse a Retry-After header value. Supports:
 *   - seconds (e.g. "120")
 *   - HTTP-date (e.g. "Wed, 21 Oct 2015 07:28:00 GMT")
 * Returns milliseconds to wait, or 0 if unparseable/negative.
 */
export function parseRetryAfter(raw: string | undefined | null): number {
  if (!raw) return 0;
  const s = String(raw).trim();
  if (!s) return 0;

  // Numeric seconds?
  if (/^\d+$/.test(s)) {
    const sec = parseInt(s, 10);
    return sec > 0 ? sec * 1000 : 0;
  }

  // HTTP-date?
  const when = Date.parse(s);
  if (Number.isNaN(when)) return 0;
  const diff = when - Date.now();
  return diff > 0 ? diff : 0;
}
