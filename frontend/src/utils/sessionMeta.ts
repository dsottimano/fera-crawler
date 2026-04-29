// Display-derived metadata for a saved crawl row in CrawlManager.vue.
// Lives in its own module so it can be unit-tested without mounting Vue.

export interface SessionRow {
  // Pre-computed in SQL via SQLite JSON1 (json_array_length(json_extract(...))).
  // Avoids JSON.parsing the (potentially multi-MB) config_json blob once per
  // row × 4 template references on every render of the saved-crawls list.
  list_total?: number;
  // Falls back to parsing config_json when list_total isn't supplied (file
  // imports, .fera bundles), but the SQL path is the hot one.
  config_json?: string;
  completed_at: string | null;
  result_count?: number;
}

export interface SessionMeta {
  mode: "list" | "spider";
  listTotal: number | null;
  status: "in progress" | "complete" | "stopped";
  statusColor: string;
  progressLabel: string;
}

function readListTotal(s: SessionRow): number | null {
  if (typeof s.list_total === "number") {
    return s.list_total > 0 ? s.list_total : null;
  }
  // Fallback path: parse config_json (e.g. for .fera file rows that didn't
  // come through the SQL JSON1 query).
  const cfgJson = s.config_json;
  if (!cfgJson || cfgJson === "{}") return null;
  let cfg: unknown;
  try { cfg = JSON.parse(cfgJson); } catch { return null; }
  if (!cfg || typeof cfg !== "object") return null;
  const obj = cfg as Record<string, unknown>;
  const nested = (obj.inputs as Record<string, unknown> | undefined)?.urls;
  if (Array.isArray(nested) && nested.length > 0) return nested.length;
  const flat = obj.urls;
  if (Array.isArray(flat) && flat.length > 0) return flat.length;
  return null;
}

export function sessionMeta(s: SessionRow): SessionMeta {
  const listTotal = readListTotal(s);
  const mode: "list" | "spider" = listTotal !== null ? "list" : "spider";
  const crawled = s.result_count ?? 0;

  let status: SessionMeta["status"];
  let statusColor: string;
  if (s.completed_at == null) {
    status = "in progress";
    statusColor = "#dcdcaa";
  } else if (mode === "list" && listTotal !== null && crawled < listTotal) {
    status = "stopped";
    statusColor = "#ce9178";
  } else {
    status = "complete";
    statusColor = "#4ec9b0";
  }

  const progressLabel = mode === "list" && listTotal !== null
    ? `${crawled.toLocaleString()} / ${listTotal.toLocaleString()} URLs`
    : `${crawled.toLocaleString()} URLs`;

  return { mode, listTotal, status, statusColor, progressLabel };
}
