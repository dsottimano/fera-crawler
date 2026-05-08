import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import type { CrawlResult, CrawlConfig } from "../types/crawl";

// Phase-7 contract: every CSV / bundle path streams from Rust. The JS
// rowsToCsv + fetchSessionRows path is gone — any export that previously
// filtered in JS now passes a typed `ResultsFilter` to the Rust exporter,
// which applies the same WHERE machinery the data grid uses.
//
// `saveCrawl` (.fera bundle) is the only path still hydrating rows in JS.
// It's a known-broken artifact: the openCrawl path only restores config;
// the rows it serializes can't be re-loaded after the Phase-6 refactor.
// Left in place rather than expanded — bundle export is the supported
// "share my crawl" path now.

/// Mirrors `ResultsFilter` in src-tauri/src/db_query.rs. All fields
/// optional; provided fields AND together server-side. Empty object =
/// every row in the session.
export interface ExportFilter {
  statusMin?: number;
  statusMax?: number;
  hasRedirect?: boolean;
  indexability?: "indexable" | "noindex" | "nofollow";
  errorPrefix?: string;
  text?: string;
  resourceType?: string;
  issuesOnly?: boolean;
  hasOgImage?: boolean;
  missingOgImage?: boolean;
  missingField?: "title" | "h1" | "h2" | "meta_description" | "canonical";
  titleLengthMin?: number;
  titleLengthMax?: number;
}

async function fetchSessionRows(sessionId: number): Promise<CrawlResult[]> {
  return invoke<CrawlResult[]>("query_all_results", { sessionId });
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
    const home = await homeDir();
    const path = await save({
      title: "Export CSV",
      defaultPath: home + "/crawl.csv",
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    await invoke("export_csv", { sessionId, destPath: path });
  }

  async function exportBundle(sessionId: number | null): Promise<void> {
    if (sessionId == null) return;
    const home = await homeDir();
    const path = await save({
      title: "Export Bundle",
      defaultPath: home + "/crawl-bundle.zip",
      filters: [{ name: "Zip Bundle", extensions: ["zip"] }],
    });
    if (!path) return;
    await invoke("export_bundle", { sessionId, destPath: path });
  }

  async function exportFilteredCsv(
    sessionId: number | null,
    filter: ExportFilter,
    defaultName: string,
  ): Promise<void> {
    if (sessionId == null) return;
    const home = await homeDir();
    const path = await save({
      title: `Export ${defaultName}`,
      defaultPath: `${home}/${defaultName}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    await invoke("export_filtered_csv", { sessionId, destPath: path, filter });
  }

  return { saveCrawl, openCrawl, exportCsv, exportBundle, exportFilteredCsv };
}
