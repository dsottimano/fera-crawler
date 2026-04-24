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
}

export class PerHostRateLimiter {
  private states = new Map<string, HostState>();

  constructor(
    /** Minimum milliseconds between successive request starts to the same host. */
    public readonly delayMs: number,
    /** Maximum concurrent in-flight requests per host. */
    public readonly maxConcurrency: number,
  ) {
    if (delayMs < 0) throw new Error("delayMs must be >= 0");
    if (maxConcurrency < 1) throw new Error("maxConcurrency must be >= 1");
  }

  private getState(host: string): HostState {
    let s = this.states.get(host);
    if (!s) {
      s = { lastRequestStartMs: 0, inFlight: 0, waiters: [] };
      this.states.set(host, s);
    }
    return s;
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

    // Gate 2: min delay since last request start to this host.
    if (this.delayMs > 0) {
      const elapsed = Date.now() - state.lastRequestStartMs;
      if (elapsed < this.delayMs) {
        await sleep(this.delayMs - elapsed);
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
