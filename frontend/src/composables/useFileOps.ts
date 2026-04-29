import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import type { CrawlResult, CrawlConfig } from "../types/crawl";

// Phase-6 contract: file ops are session-scoped, not array-scoped. Rather
// than the caller passing in a CrawlResult[] (which after the cleanup
// nobody holds in memory), they pass the active session id and we stream
// rows from Rust via query_all_results. Same shape goes into the .fera
// bundle; same shape goes into the CSV.

async function fetchSessionRows(sessionId: number): Promise<CrawlResult[]> {
  return invoke<CrawlResult[]>("query_all_results", { sessionId });
}

function rowsToCsv(rows: CrawlResult[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (val: string) =>
    val.includes(",") || val.includes('"') || val.includes("\n")
      ? `"${val.replace(/"/g, '""')}"`
      : val;
  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((h) => escape(String((row as any)[h] ?? ""))).join(","),
    ),
  ];
  return lines.join("\n");
}

export function useFileOps() {
  async function saveCrawl(sessionId: number | null, config?: CrawlConfig): Promise<boolean> {
    if (sessionId == null) return false;
    const rows = await fetchSessionRows(sessionId);
    if (!rows.length) return false;
    const home = await homeDir();
    const path = await save({
      title: "Save Crawl",
      defaultPath: home + "/crawl.fera",
      filters: [{ name: "Fera Crawl", extensions: ["fera"] }],
    });
    if (!path) return false;
    await writeTextFile(path, JSON.stringify({ version: 2, config: config ?? {}, results: rows }, null, 2));
    return true;
  }

  async function openCrawl(): Promise<{ results: CrawlResult[]; config?: CrawlConfig } | null> {
    const home = await homeDir();
    const path = await open({
      title: "Open Crawl",
      defaultPath: home,
      filters: [{ name: "Fera Crawl", extensions: ["fera"] }],
      multiple: false,
      directory: false,
    });
    if (!path) return null;
    try {
      const text = await readTextFile(path as string);
      const data = JSON.parse(text);
      return { results: data.results ?? [], config: data.config };
    } catch (e) {
      console.error("Failed to open crawl file:", e);
      return null;
    }
  }

  async function exportCsv(sessionId: number | null): Promise<void> {
    if (sessionId == null) return;
    const rows = await fetchSessionRows(sessionId);
    if (!rows.length) return;
    const home = await homeDir();
    const path = await save({
      title: "Export CSV",
      defaultPath: home + "/crawl.csv",
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    await writeTextFile(path, rowsToCsv(rows));
  }

  async function exportFilteredCsv(
    sessionId: number | null,
    filterFn: (r: CrawlResult) => boolean,
    defaultName: string,
  ): Promise<void> {
    if (sessionId == null) return;
    const rows = (await fetchSessionRows(sessionId)).filter(filterFn);
    if (!rows.length) return;
    const home = await homeDir();
    const path = await save({
      title: `Export ${defaultName}`,
      defaultPath: `${home}/${defaultName}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    await writeTextFile(path, rowsToCsv(rows));
  }

  return { saveCrawl, openCrawl, exportCsv, exportFilteredCsv };
}
