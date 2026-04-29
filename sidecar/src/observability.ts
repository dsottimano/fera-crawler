import { writeEvent, type LogLevel } from "./pipeline.js";

interface Counters {
  queueSize: number;
  inFlight: number;
  processed: number;
  errors: number;
}

const state: Counters = {
  queueSize: 0,
  inFlight: 0,
  processed: 0,
  errors: 0,
};

// Rolling window for pages/sec: timestamps of the last N completions.
const recentCompletions: number[] = [];
const ROLLING_WINDOW_MS = 10_000;

let metricTimer: NodeJS.Timeout | null = null;

// Per-URL debug events (navigating / page complete / rate-limit gap) cost one
// IPC hop each on the Rust→Tauri→Vue path, so a 30k-URL crawl emits ~100k log
// events even when nobody is watching the panel. Off by default; turned on by
// the `advanced.debugLog` setting via `--debug-log`.
let debugEnabled = false;

export function setDebugEnabled(on: boolean): void {
  debugEnabled = on;
}

export function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (level === "debug" && !debugEnabled) return;
  writeEvent({ type: "log", ts: Date.now(), level, msg, meta });
}

export function phase(name: string, meta?: Record<string, unknown>): void {
  writeEvent({ type: "phase", ts: Date.now(), name, meta });
}

export function setQueueSize(n: number): void {
  state.queueSize = n;
}

export function setInFlight(n: number): void {
  state.inFlight = n;
}

export function recordCompletion(): void {
  state.processed++;
  const now = Date.now();
  recentCompletions.push(now);
  // Trim window
  while (recentCompletions.length && now - recentCompletions[0] > ROLLING_WINDOW_MS) {
    recentCompletions.shift();
  }
}

export function recordError(): void {
  state.errors++;
}

// Rate = completions in the wall-clock window / window seconds. Dividing by
// the *span between samples* (previous formula) collapses the denominator
// toward 0 when several workers finish in the same millisecond, producing
// nonsense like 5000 pages/sec right after warmup. Floor the denominator
// at MIN_WINDOW_MS so a freshly-started crawl can't divide by ~0 either.
const MIN_WINDOW_MS = 1000;
function pagesPerSec(): number {
  if (recentCompletions.length === 0) return 0;
  const now = Date.now();
  const oldest = recentCompletions[0];
  const elapsedMs = Math.max(now - oldest, MIN_WINDOW_MS);
  return +((recentCompletions.length / (elapsedMs / 1000)).toFixed(2));
}

function emitMetric(): void {
  // HEALTH consumes only the operational fields (queue/inFlight/pps and the
  // counters). The Node memory stats that used to ride this event were never
  // user-actionable — the budget is flat regardless — so they're omitted.
  writeEvent({
    type: "metric",
    ts: Date.now(),
    queueSize: state.queueSize,
    inFlight: state.inFlight,
    processed: state.processed,
    errors: state.errors,
    pagesPerSec: pagesPerSec(),
  });
}

export function startMetricEmitter(intervalMs = 1000): void {
  if (metricTimer) return;
  emitMetric(); // initial sample so UI has immediate data
  metricTimer = setInterval(emitMetric, intervalMs);
  // Don't keep process alive on this timer alone.
  if (metricTimer.unref) metricTimer.unref();
}

export function stopMetricEmitter(): void {
  if (metricTimer) {
    clearInterval(metricTimer);
    metricTimer = null;
  }
}
