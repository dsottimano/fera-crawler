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

function pagesPerSec(): number {
  if (recentCompletions.length < 2) return 0;
  const spanMs = recentCompletions[recentCompletions.length - 1] - recentCompletions[0];
  if (spanMs <= 0) return 0;
  return +((recentCompletions.length / (spanMs / 1000)).toFixed(2));
}

function emitMetric(): void {
  const mem = process.memoryUsage();
  writeEvent({
    type: "metric",
    ts: Date.now(),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
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
