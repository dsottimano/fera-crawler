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

export function writeLine(result: CrawlResult): void {
  // Existing contract: raw CrawlResult (no `type` field) — Rust routes to crawl-result.
  process.stdout.write(JSON.stringify(result) + "\n");
}

export function writeEvent(e: SidecarEvent): void {
  // Events carry a `type` field so Rust can discriminate them from crawl results.
  process.stdout.write(JSON.stringify(e) + "\n");
}

// Escape hatch for typed events defined elsewhere (block-detected, probe-result).
// Keeps the strict SidecarEvent union pure for core events.
export function writeAnyEvent(e: { type: string } & Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(e) + "\n");
}
