import { ref, type Ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

export type LogLevel = "debug" | "info" | "warn" | "error" | "stderr" | "stdout";

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  msg: string;
  meta?: Record<string, unknown>;
}

export interface MetricSample {
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

export interface PhaseEntry {
  ts: number;
  name: string;
  meta?: Record<string, unknown>;
}

export interface DebugSnapshot {
  appStartEpoch: number;
  uptimeSec: number;
  hostPid: number;
  hostProc: { rssBytes: number; vmBytes: number; state: string; threads: number } | null;
  sidecarPid: number;
  sidecarProc: { rssBytes: number; vmBytes: number; state: string; threads: number } | null;
  sidecarChildren: Array<{ pid: number; proc: Record<string, unknown> }>;
  crawlGeneration: number;
  dataDir: string | null;
  dbPath: string | null;
  dbSizeBytes: number;
  os: string;
  arch: string;
}

const LOG_CAP = 5000;
const METRIC_CAP = 300;

const logs: Ref<LogEntry[]> = ref([]);
const metrics: Ref<MetricSample[]> = ref([]);
const phases: Ref<PhaseEntry[]> = ref([]);
const latestMetric: Ref<MetricSample | null> = ref(null);
const currentPhase: Ref<string | null> = ref(null);
const snapshot: Ref<DebugSnapshot | null> = ref(null);

let started = false;
let unlisteners: UnlistenFn[] = [];
let logSeq = 0;

async function start(): Promise<void> {
  if (started) return;
  started = true;

  unlisteners.push(
    await listen<Omit<LogEntry, "id">>("sidecar-log", (e) => {
      const entry: LogEntry = { id: ++logSeq, ...e.payload };
      logs.value.push(entry);
      if (logs.value.length > LOG_CAP) logs.value.splice(0, logs.value.length - LOG_CAP);
    })
  );

  unlisteners.push(
    await listen<MetricSample>("sidecar-metric", (e) => {
      const m = e.payload;
      metrics.value.push(m);
      if (metrics.value.length > METRIC_CAP) {
        metrics.value.splice(0, metrics.value.length - METRIC_CAP);
      }
      latestMetric.value = m;
    })
  );

  unlisteners.push(
    await listen<PhaseEntry>("sidecar-phase", (e) => {
      phases.value.push(e.payload);
      currentPhase.value = e.payload.name;
    })
  );

  unlisteners.push(
    await listen("crawl-complete", () => {
      currentPhase.value = "idle";
    })
  );

  // A new crawl is its own log scope — wipe the prior run's noise so the
  // panel only shows what's relevant to the current crawl.
  unlisteners.push(
    await listen("crawl-started", () => {
      logs.value = [];
      phases.value = [];
      currentPhase.value = "starting";
    })
  );
}

async function stop(): Promise<void> {
  // Listeners are kept alive app-wide by design (logs should persist across panel open/close).
  // Explicit stop available if we ever need it.
  for (const fn of unlisteners) {
    try { fn(); } catch {}
  }
  unlisteners = [];
  started = false;
}

function clearLogs(): void {
  logs.value = [];
}

function clearMetrics(): void {
  metrics.value = [];
}

async function refreshSnapshot(): Promise<DebugSnapshot> {
  const s = await invoke<DebugSnapshot>("debug_snapshot");
  snapshot.value = s;
  return s;
}

async function killSidecar(): Promise<void> {
  await invoke("kill_sidecar");
}

async function wipeBrowserProfile(): Promise<string> {
  return await invoke<string>("wipe_browser_profile");
}

export function useDebug() {
  return {
    logs,
    metrics,
    phases,
    latestMetric,
    currentPhase,
    snapshot,
    start,
    stop,
    clearLogs,
    clearMetrics,
    refreshSnapshot,
    killSidecar,
    wipeBrowserProfile,
  };
}
