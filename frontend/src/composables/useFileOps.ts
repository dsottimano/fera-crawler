import { save, open } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { CrawlResult } from "../types/crawl";

export function useFileOps() {
  async function saveCrawl(results: CrawlResult[]): Promise<void> {
    const path = await save({
      title: "Save Crawl",
      defaultPath: "crawl.fera",
      filters: [{ name: "Fera Crawl", extensions: ["fera"] }],
    });
    if (!path) return;
    await writeTextFile(path, JSON.stringify({ version: 1, results }, null, 2));
  }

  async function openCrawl(): Promise<CrawlResult[] | null> {
    const path = await open({
      title: "Open Crawl",
      filters: [{ name: "Fera Crawl", extensions: ["fera"] }],
      multiple: false,
      directory: false,
    });
    if (!path) return null;
    try {
      const text = await readTextFile(path as string);
      const data = JSON.parse(text);
      return data.results ?? [];
    } catch (e) {
      console.error("Failed to open crawl file:", e);
      return null;
    }
  }

  async function exportCsv(results: CrawlResult[]): Promise<void> {
    if (!results.length) return;
    const headers = Object.keys(results[0]);
    const lines = [
      headers.join(","),
      ...results.map((row) =>
        headers
          .map((h) => {
            const val = String((row as any)[h] ?? "");
            return val.includes(",") || val.includes('"') || val.includes("\n")
              ? `"${val.replace(/"/g, '""')}"`
              : val;
          })
          .join(",")
      ),
    ];

    const path = await save({
      title: "Export CSV",
      defaultPath: "crawl.csv",
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    await writeTextFile(path, lines.join("\n"));
  }

  async function exportFilteredCsv(
    results: CrawlResult[],
    filterFn: (r: CrawlResult) => boolean,
    defaultName: string
  ): Promise<void> {
    const filtered = results.filter(filterFn);
    if (!filtered.length) return;
    const headers = Object.keys(filtered[0]);
    const lines = [
      headers.join(","),
      ...filtered.map((row) =>
        headers
          .map((h) => {
            const val = String((row as any)[h] ?? "");
            return val.includes(",") || val.includes('"') || val.includes("\n")
              ? `"${val.replace(/"/g, '""')}"`
              : val;
          })
          .join(",")
      ),
    ];

    const path = await save({
      title: `Export ${defaultName}`,
      defaultPath: `${defaultName}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    await writeTextFile(path, lines.join("\n"));
  }

  return { saveCrawl, openCrawl, exportCsv, exportFilteredCsv };
}
