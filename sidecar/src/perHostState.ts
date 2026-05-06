import type { Classification } from "./responseClassifier.js";

const BASELINE_SAMPLES = 20;
const WINDOW_MAX = 100;
const DEFAULT_MAX_HOSTS = 1000;

interface HostState {
  bodySamples: number[];
  linkSamples: number[];
  cachedBaseline: { medianBodyBytes: number; medianInternalLinks: number } | null;
  window: Classification[];
  cleanStreak: number;
  consecutive403: number;
  lastBlockMonoMs: number | null;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
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

export class PerHostStates {
  private map = new Map<string, HostState>();
  private maxHosts: number;

  constructor(maxHosts: number = DEFAULT_MAX_HOSTS) {
    this.maxHosts = maxHosts;
  }

  has(host: string): boolean {
    return this.map.has(host);
  }

  private touch(host: string): HostState {
    let s = this.map.get(host);
    if (s) {
      this.map.delete(host);
      this.map.set(host, s);
      return s;
    }
    s = {
      bodySamples: [],
      linkSamples: [],
      cachedBaseline: null,
      window: [],
      cleanStreak: 0,
      consecutive403: 0,
      lastBlockMonoMs: null,
    };
    this.map.set(host, s);
    if (this.map.size > this.maxHosts) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return s;
  }

  recordOk(host: string, bodyBytes: number, internalLinks: number): void {
    const s = this.touch(host);
    if (s.bodySamples.length >= BASELINE_SAMPLES) return;
    s.bodySamples.push(bodyBytes);
    s.linkSamples.push(internalLinks);
    if (s.bodySamples.length === BASELINE_SAMPLES) {
      const bSorted = [...s.bodySamples].sort((a, b) => a - b);
      const lSorted = [...s.linkSamples].sort((a, b) => a - b);
      s.cachedBaseline = { medianBodyBytes: median(bSorted), medianInternalLinks: median(lSorted) };
    }
  }

  baseline(host: string): { medianBodyBytes: number; medianInternalLinks: number } | null {
    return this.map.get(host)?.cachedBaseline ?? null;
  }

  recordClassification(host: string, c: Classification): void {
    const s = this.touch(host);
    s.window.push(c);
    if (s.window.length > WINDOW_MAX) s.window.shift();
    if (isBlocked(c)) {
      s.cleanStreak = 0;
      s.lastBlockMonoMs = monoNowMs();
    } else if (c === "ok") {
      s.cleanStreak++;
    }
    if (c === "blocked-status:403") s.consecutive403++;
    else s.consecutive403 = 0;
  }

  cleanStreak(host: string): number {
    return this.map.get(host)?.cleanStreak ?? 0;
  }

  resetCleanStreak(host: string): void {
    const s = this.map.get(host);
    if (s) s.cleanStreak = 0;
  }

  consecutive403(host: string): number {
    return this.map.get(host)?.consecutive403 ?? 0;
  }

  windowSize(host: string): number {
    return this.map.get(host)?.window.length ?? 0;
  }

  blockRate(host: string): number {
    const s = this.map.get(host);
    if (!s || s.window.length === 0) return 0;
    let blocked = 0;
    for (const c of s.window) if (isBlocked(c)) blocked++;
    return blocked / s.window.length;
  }

  setLastBlockNow(host: string): void {
    this.touch(host).lastBlockMonoMs = monoNowMs();
  }

  sinceLastBlockMs(host: string): number {
    const t = this.map.get(host)?.lastBlockMonoMs;
    return t === null || t === undefined ? Number.POSITIVE_INFINITY : monoNowMs() - t;
  }

  hosts(): string[] {
    return [...this.map.keys()];
  }
}
