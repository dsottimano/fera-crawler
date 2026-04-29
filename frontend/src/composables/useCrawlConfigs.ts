import { ref, type Ref } from "vue";
import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { serializeWrite } from "../utils/dbWrite";

let dbPromise: Promise<Database> | null = null;
function getDb(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load("sqlite:fera.db");
  return dbPromise;
}

export type QualityFlag =
  | "fake-200"
  | "bot-verdict-visible"
  | "thin-body-lt5kb"
  | "low-content-lt30w"
  | "no-seo-all3"
  | "cloaked-5pct"
  | "zero-outlinks";

export interface QualitySignals {
  score: number;
  flags: QualityFlag[];
  bodyBytes: number;
  wordCount: number;
  title: string;
  h1: string;
  outlinkCount: number;
  passes: boolean;
}

export interface SpeedSignals {
  firstMs: number;
  sampleMs: number[];
  failedSamples: number;
  medianMs: number | null;
}

export interface ProbeAttempt {
  step: number;
  label: string;
  config: Record<string, unknown>;
  status: number | null;
  ok: boolean;
  blocked: boolean;
  ms: number;
  quality: QualitySignals | null;
  speed: SpeedSignals | null;
  passesAllGates: boolean;
  error?: string;
}

export interface ProbeRanking {
  label: string;
  firstMs: number;
  medianMs: number | null;
  qualityScore: number;
  passesAllGates: boolean;
}

export interface ProbeResult {
  url: string;
  winningConfig: Record<string, unknown> | null;
  winningLabel: string | null;
  attempts: ProbeAttempt[];
  ranking: ProbeRanking[];
  probedAt: string;
}

export interface CrawlConfigRow {
  domain: string;
  config: Record<string, unknown>;
  winningLabel: string | null;
  attempts: ProbeAttempt[];
  probedAt: string;
}

interface DbRow {
  domain: string;
  config_json: string;
  winning_label: string | null;
  attempts_json: string;
  probed_at: string;
}

function rowToConfig(r: DbRow): CrawlConfigRow {
  let config: Record<string, unknown> = {};
  let attempts: ProbeAttempt[] = [];
  try { config = JSON.parse(r.config_json) as Record<string, unknown>; } catch {}
  try { attempts = JSON.parse(r.attempts_json) as ProbeAttempt[]; } catch {}
  return {
    domain: r.domain,
    config,
    winningLabel: r.winning_label,
    attempts,
    probedAt: r.probed_at,
  };
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

const configs: Ref<CrawlConfigRow[]> = ref([]);
const probing = ref<string | null>(null);

async function listConfigs(): Promise<void> {
  const d = await getDb();
  const rows = await d.select<DbRow[]>(
    "SELECT domain, config_json, winning_label, attempts_json, probed_at FROM crawl_configs ORDER BY probed_at DESC"
  );
  configs.value = rows.map(rowToConfig);
}

async function probeAndSave(url: string): Promise<ProbeResult> {
  probing.value = domainOf(url);
  try {
    const result = await invoke<ProbeResult>("probe_crawl_config", { url });
    const domain = domainOf(url);
    await serializeWrite(async () => {
      const d = await getDb();
      await d.execute(
        `INSERT INTO crawl_configs (domain, config_json, winning_label, attempts_json, probed_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(domain) DO UPDATE SET
           config_json = excluded.config_json,
           winning_label = excluded.winning_label,
           attempts_json = excluded.attempts_json,
           probed_at = excluded.probed_at`,
        [
          domain,
          JSON.stringify(result.winningConfig ?? {}),
          result.winningLabel,
          JSON.stringify(result.attempts ?? []),
          result.probedAt,
        ]
      );
    });
    await listConfigs();
    return result;
  } finally {
    probing.value = null;
  }
}

async function deleteConfig(domain: string): Promise<void> {
  await serializeWrite(async () => {
    const d = await getDb();
    await d.execute("DELETE FROM crawl_configs WHERE domain = $1", [domain]);
  });
  await listConfigs();
}

export function useCrawlConfigs() {
  return {
    configs,
    probing,
    listConfigs,
    probeAndSave,
    deleteConfig,
  };
}
