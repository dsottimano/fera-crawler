import { save, open } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import type { CrawlResult, CrawlConfig } from "../types/crawl";

export function useFileOps() {
  async function saveCrawl(results: CrawlResult[], config?: CrawlConfig): Promise<boolean> {
    const home = await homeDir();
    const path = await save({
      title: "Save Crawl",
      defaultPath: home + "/crawl.fera",
      filters: [{ name: "Fera Crawl", extensions: ["fera"] }],
    });
    if (!path) return false;
    await writeTextFile(path, JSON.stringify({ version: 2, config: config ?? {}, results }, null, 2));
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

    const home = await homeDir();
    const path = await save({
      title: "Export CSV",
      defaultPath: home + "/crawl.csv",
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

    const home = await homeDir();
    const path = await save({
      title: `Export ${defaultName}`,
      defaultPath: `${home}/${defaultName}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    await writeTextFile(path, lines.join("\n"));
  }

  return { saveCrawl, openCrawl, exportCsv, exportFilteredCsv };
}
