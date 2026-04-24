import Database from "better-sqlite3";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { DB_PATH, APP_DATA, SIDECAR_DIR, SIDECAR_ENTRY } from "./paths.js";

export interface ProbeAttempt {
  step: number;
  label: string;
  config: Record<string, unknown>;
  status: number | null;
  ok: boolean;
  blocked: boolean;
  ms: number;
  quality: {
    score: number;
    flags: string[];
    bodyBytes: number;
    wordCount: number;
    title: string;
    h1: string;
    outlinkCount: number;
    passes: boolean;
  } | null;
  speed: {
    firstMs: number;
    sampleMs: number[];
    failedSamples: number;
    medianMs: number | null;
  } | null;
  passesAllGates: boolean;
  error?: string;
}

export interface ProbeResult {
  url: string;
  winningConfig: Record<string, unknown> | null;
  winningLabel: string | null;
  attempts: ProbeAttempt[];
  ranking: Array<{ label: string; firstMs: number; medianMs: number | null; qualityScore: number; passesAllGates: boolean }>;
  probedAt: string;
}

export interface CachedConfig {
  domain: string;
  config: Record<string, unknown>;
  winningLabel: string | null;
  probedAt: string;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

function ensureDb(): Database.Database {
  fs.mkdirSync(APP_DATA, { recursive: true });
  const db = new Database(DB_PATH);
  // The Tauri app creates this table via migration 6. If the user runs MCP
  // standalone (no app), we create it here so reads/writes work anyway.
  db.exec(`CREATE TABLE IF NOT EXISTS crawl_configs (
    domain TEXT PRIMARY KEY,
    config_json TEXT NOT NULL,
    winning_label TEXT,
    attempts_json TEXT NOT NULL DEFAULT '[]',
    probed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  return db;
}

export function getConfigForUrl(url: string): CachedConfig | null {
  const domain = domainOf(url);
  const db = ensureDb();
  try {
    const row = db.prepare(
      "SELECT domain, config_json, winning_label, probed_at FROM crawl_configs WHERE domain = ?"
    ).get(domain) as { domain: string; config_json: string; winning_label: string | null; probed_at: string } | undefined;
    if (!row) return null;
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(row.config_json); } catch {}
    return { domain: row.domain, config, winningLabel: row.winning_label, probedAt: row.probed_at };
  } finally {
    db.close();
  }
}

export function listConfigs(): CachedConfig[] {
  const db = ensureDb();
  try {
    const rows = db.prepare(
      "SELECT domain, config_json, winning_label, probed_at FROM crawl_configs ORDER BY probed_at DESC"
    ).all() as Array<{ domain: string; config_json: string; winning_label: string | null; probed_at: string }>;
    return rows.map((r) => {
      let config: Record<string, unknown> = {};
      try { config = JSON.parse(r.config_json); } catch {}
      return { domain: r.domain, config, winningLabel: r.winning_label, probedAt: r.probed_at };
    });
  } finally {
    db.close();
  }
}

export function saveConfig(result: ProbeResult): void {
  const domain = domainOf(result.url);
  const db = ensureDb();
  try {
    db.prepare(
      `INSERT INTO crawl_configs (domain, config_json, winning_label, attempts_json, probed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET
         config_json = excluded.config_json,
         winning_label = excluded.winning_label,
         attempts_json = excluded.attempts_json,
         probed_at = excluded.probed_at`
    ).run(
      domain,
      JSON.stringify(result.winningConfig ?? {}),
      result.winningLabel,
      JSON.stringify(result.attempts ?? []),
      result.probedAt,
    );
  } finally {
    db.close();
  }
}

export function deleteCachedConfig(domain: string): void {
  const db = ensureDb();
  try {
    db.prepare("DELETE FROM crawl_configs WHERE domain = ?").run(domain);
  } finally {
    db.close();
  }
}

export function runProbe(url: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["tsx", SIDECAR_ENTRY, "probe-config", url], {
      cwd: SIDECAR_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout!.on("data", (c: Buffer) => { stdout += c.toString(); });
    proc.stderr!.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("error", reject);
    proc.on("close", () => {
      const lines = stdout.trim().split("\n").reverse();
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && Array.isArray(parsed.attempts)) {
            resolve(parsed as ProbeResult);
            return;
          }
        } catch {}
      }
      reject(new Error(`probe-config produced no result. stderr: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

export async function probeAndCache(url: string): Promise<ProbeResult> {
  const result = await runProbe(url);
  saveConfig(result);
  return result;
}
