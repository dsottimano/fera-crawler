import type { CrawlResult } from "./types.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  type: "log";
  ts: number;
  level: LogLevel;
  msg: string;
  meta?: Record<string, unknown>;
}

export interface MetricEvent {
  type: "metric";
  ts: number;
  queueSize: number;
  inFlight: number;
  processed: number;
  errors: number;
  pagesPerSec: number;
}

export interface PhaseEvent {
  type: "phase";
  ts: number;
  name: string;
  meta?: Record<string, unknown>;
}

// Per-request timing breakdown for the live Network Map view. Ephemeral —
// Rust forwards these as Tauri events but never persists them. Numbers in
// ms; phase==0 means the connection was reused (DNS/TCP/TLS skipped).
export interface TimingEvent {
  type: "timing";
  ts: number;
  url: string;
  host: string;
  status: number;
  dns: number;
  tcp: number;
  tls: number;
  ttfb: number;
  download: number;
  total: number;
  reused: boolean;
  bytes: number;
}

export type SidecarEvent = LogEvent | MetricEvent | PhaseEvent | TimingEvent;

// Backpressure gate. `process.stdout.write` returns false once its internal
// buffer passes the high-water mark, meaning the consumer (Rust, reading the
// pipe) is slower than we're producing. Ignoring that return value buffers the
// unwritten JSON unboundedly in the Node heap — and one CrawlResult row can be
// hundreds of KB (up to 5000 outlinks + internal URLs). We keep the write calls
// synchronous (so recordResult and its callers don't have to become async) and
// instead expose whenStdoutDrained() for the async worker loop to await at a
// safe point, pausing production while stdout is saturated.
let drainPromise: Promise<void> | null = null;

function rawWrite(s: string): void {
  const ok = process.stdout.write(s);
  if (!ok && !drainPromise) {
    drainPromise = new Promise<void>((resolve) => {
      process.stdout.once("drain", () => {
        drainPromise = null;
        resolve();
      });
    });
  }
}

/** Resolves immediately unless stdout is backed up, in which case it resolves
 *  on the next 'drain'. Await this at a cooperative yield point (the worker
 *  loop) to bound the outbound buffer. */
export function whenStdoutDrained(): Promise<void> {
  return drainPromise ?? Promise.resolve();
}

export function writeLine(result: CrawlResult): void {
  // Existing contract: raw CrawlResult (no `type` field) — Rust routes to crawl-result.
  rawWrite(JSON.stringify(result) + "\n");
}

export function writeEvent(e: SidecarEvent): void {
  // Events carry a `type` field so Rust can discriminate them from crawl results.
  rawWrite(JSON.stringify(e) + "\n");
}

// Escape hatch for typed events defined elsewhere (block-detected, probe-result).
// Keeps the strict SidecarEvent union pure for core events.
export function writeAnyEvent(e: { type: string } & Record<string, unknown>): void {
  rawWrite(JSON.stringify(e) + "\n");
}
