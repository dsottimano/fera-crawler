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
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
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

export type SidecarEvent = LogEvent | MetricEvent | PhaseEvent;

export function writeLine(result: CrawlResult): void {
  // Existing contract: raw CrawlResult (no `type` field) — Rust routes to crawl-result.
  process.stdout.write(JSON.stringify(result) + "\n");
}

export function writeEvent(e: SidecarEvent): void {
  // Events carry a `type` field so Rust can discriminate them from crawl results.
  process.stdout.write(JSON.stringify(e) + "\n");
}
