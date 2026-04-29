<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { TabulatorFull as Tabulator } from "tabulator-tables";
import type { CrawlResult } from "../types/crawl";
import { useConfig } from "../composables/useConfig";
import { buildResultsFilter, sortFieldToColumn, type ResultsFilter } from "../utils/gridFilter";
import "tabulator-tables/dist/css/tabulator_midnight.min.css";

// Phase-4 contract: the grid is data-bound to a session id, NOT to an
// in-memory results array. Tabulator runs in pagination=remote +
// progressiveLoad=scroll mode and pulls pages from the Rust query commands
// as the user scrolls. `refreshKey` is bumped by the parent (on
// crawl-progress, on tab/filter change, on recrawl-queue mutation) to
// force the grid to ask Rust for fresh data.
const props = defineProps<{
  sessionId: number | null;
  activeTab: string;
  filterType?: string;
  searchQuery?: string;
  selectAll?: number;
  refreshKey?: number;
}>();
const emit = defineEmits<{ rowSelect: [result: CrawlResult | null]; recrawl: [urls: string[]]; filteredCount: [count: number] }>();

const { config } = useConfig();
const tableRef = ref<HTMLDivElement>();
let table: any = null;

const ctxMenu = ref<{ x: number; y: number; count: number } | null>(null);

function showContextMenu(x: number, y: number) {
  const count = table?.getSelectedRows()?.length ?? 0;
  if (!count) return;
  ctxMenu.value = { x, y, count };
  const close = (e: Event) => {
    ctxMenu.value = null;
    document.removeEventListener("click", close);
    document.removeEventListener("contextmenu", close);
  };
  setTimeout(() => {
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
  }, 0);
}

function handleRecrawl() {
  const urls = selectedUrls();
  ctxMenu.value = null;
  if (urls.length) emit("recrawl", urls);
}

function selectedUrls(): string[] {
  const selected = table?.getSelectedRows() ?? [];
  return selected.map((r: any) => (r.getData() as CrawlResult).url);
}

async function handleCopyUrls() {
  const urls = selectedUrls();
  ctxMenu.value = null;
  if (!urls.length) return;
  const text = urls.join("\n");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback for older webviews — create a textarea, select, exec copy.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  } catch (e) {
    console.error("clipboard write failed", e);
  }
}

async function handleOpenInBrowser() {
  const urls = selectedUrls();
  ctxMenu.value = null;
  if (!urls.length) return;
  // Multi-select fallback: Tauri opens each URL in the default browser.
  // Most users will only have one selected (single-click selection).
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  for (const url of urls) {
    try { await openUrl(url); }
    catch (e) { console.error("openUrl failed", url, e); }
  }
}

/* ── Formatters ── */

function statusCodeFormatter(cell: any) {
  const val = cell.getValue() as number;
  if (!val) return "";
  const color = val >= 200 && val < 300 ? "#4ec9b0" : val >= 300 && val < 400 ? "#dcdcaa" : "#f44747";
  return `<span style="color:${color};font-weight:600">${val}</span>`;
}

function statusTextFormatter(cell: any) {
  const row = cell.getRow().getData() as CrawlResult;
  const s = row.status;
  if (s >= 200 && s < 300) return "OK";
  if (s === 301) return "Moved Permanently";
  if (s === 302) return "Found";
  if (s === 304) return "Not Modified";
  if (s === 404) return "Not Found";
  if (s === 410) return "Gone";
  if (s === 429) return "Too Many Requests";
  if (s >= 500) return "Server Error";
  if (s >= 400) return "Client Error";
  if (s >= 300) return "Redirect";

  // status === 0 — request never got an HTTP response (or was parked by the
  // block detector). Distinguish the two so the user can tell at a glance.
  const err = row.error ?? "";
  const escape = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

  if (err.startsWith("host_blocked_by_detector")) {
    const host = err.split(":")[1] ?? "";
    return `<span style="color:#dcdcaa" title="Parked by block detector — host '${escape(host)}' tripped the 10-of-15 block threshold. Use the banner Probe button to find a working config.">Parked (host paused)</span>`;
  }
  if (err) {
    // Surface a compact reason inline; full text in the tooltip.
    let short = err;
    if (/timeout/i.test(err)) short = "Timeout";
    else if (/ERR_CONNECTION_RESET|ECONNRESET/i.test(err)) short = "Connection reset";
    else if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(err)) short = "DNS failed";
    else if (/ERR_CERT|SSL|TLS/i.test(err)) short = "TLS error";
    else if (/ERR_HTTP2/i.test(err)) short = "HTTP/2 error";
    else if (/ERR_ABORTED|aborted/i.test(err)) short = "Aborted";
    else if (err.length > 40) short = err.slice(0, 38) + "…";
    return `<span style="color:#f44747" title="${escape(err)}">${escape(short)}</span>`;
  }
  return "";
}

function sizeFormatter(cell: any) {
  const val = cell.getValue() as number;
  if (!val) return "";
  if (val < 1024) return `${val} B`;
  if (val < 1048576) return `${(val / 1024).toFixed(1)} KB`;
  return `${(val / 1048576).toFixed(1)} MB`;
}

function responseTimeFormatter(cell: any) {
  const val = cell.getValue() as number;
  return val ? val + "ms" : "";
}

function lengthFormatter(cell: any) {
  const val = (cell.getValue() as string) || "";
  return val.length ? String(val.length) : "";
}

function boolFormatter(cell: any) {
  const val = cell.getValue();
  if (val === true) return '<span style="color:#f44747;font-weight:600">Yes</span>';
  if (val === false) return '<span style="color:#4ec9b0">No</span>';
  return "";
}

function indexableFormatter(cell: any) {
  const val = cell.getValue();
  if (val === true) return '<span style="color:#4ec9b0;font-weight:600">Yes</span>';
  if (val === false) return '<span style="color:#f44747;font-weight:600">No</span>';
  return "";
}

function dimensionFormatter(cell: any) {
  const val = cell.getValue() as number;
  return val ? `${val}px` : "";
}

function wordCountFormatter(cell: any) {
  const val = cell.getValue() as number;
  return val ? String(val) : "";
}

function outlinkCountFormatter(cell: any) {
  const row = cell.getRow().getData() as CrawlResult;
  return row.outlinks?.length ? String(row.outlinks.length) : "0";
}

function maxImagePreviewFormatter(cell: any) {
  const robots = (cell.getRow().getData() as CrawlResult).metaRobots || "";
  const match = robots.match(/max-image-preview:\s*(\w+)/i);
  return match ? match[1] : "";
}

/* ── Column definitions pool ── */

const COL = {
  address:        { title: "Address", field: "url", minWidth: 300, widthGrow: 3, tooltip: true },
  contentType:    { title: "Content Type", field: "contentType", minWidth: 140, width: 160 },
  statusCode:     { title: "Status Code", field: "status", width: 90, hozAlign: "center", formatter: statusCodeFormatter },
  statusText:     { title: "Status", field: "_statusText", width: 130, formatter: statusTextFormatter },
  title:          { title: "Title 1", field: "title", minWidth: 200, widthGrow: 2, tooltip: true },
  titleLen:       { title: "Title Length", field: "title", width: 100, hozAlign: "center", formatter: lengthFormatter },
  h1:             { title: "H1", field: "h1", minWidth: 200, widthGrow: 2, tooltip: true },
  h1Len:          { title: "H1 Length", field: "h1", width: 90, hozAlign: "center", formatter: lengthFormatter },
  h2:             { title: "H2", field: "h2", minWidth: 200, widthGrow: 2, tooltip: true },
  h2Len:          { title: "H2 Length", field: "h2", width: 90, hozAlign: "center", formatter: lengthFormatter },
  metaDesc:       { title: "Meta Description", field: "metaDescription", minWidth: 200, widthGrow: 2, tooltip: true },
  metaDescLen:    { title: "Meta Desc Length", field: "metaDescription", width: 110, hozAlign: "center", formatter: lengthFormatter },
  canonical:      { title: "Canonical", field: "canonical", minWidth: 200, widthGrow: 2, tooltip: true },
  intLinks:       { title: "Inlinks", field: "internalLinks", width: 80, hozAlign: "center" },
  extLinks:       { title: "Outlinks", field: "externalLinks", width: 80, hozAlign: "center" },
  uniqueOutlinks: { title: "Unique Outlinks", field: "_outlinkCount", width: 110, hozAlign: "center", formatter: outlinkCountFormatter },
  responseTime:   { title: "Response Time", field: "responseTime", width: 110, hozAlign: "right", formatter: responseTimeFormatter },
  resource:       { title: "Resource", field: "resourceType", width: 90 },
  size:           { title: "Size", field: "size", width: 80, hozAlign: "right", formatter: sizeFormatter },
  server:         { title: "Server", field: "serverHeader", minWidth: 100, width: 120, tooltip: true },
  redirectUrl:    { title: "Redirect URL", field: "redirectUrl", minWidth: 200, widthGrow: 2, tooltip: true },
  wordCount:      { title: "Word Count", field: "wordCount", width: 90, hozAlign: "center", formatter: wordCountFormatter },

  // Robots directives
  metaRobots:     { title: "Meta Robots", field: "metaRobots", minWidth: 160, width: 200, tooltip: true },
  indexable:      { title: "Indexable", field: "isIndexable", width: 80, hozAlign: "center", formatter: indexableFormatter },
  noindex:        { title: "Noindex", field: "isNoindex", width: 80, hozAlign: "center", formatter: boolFormatter },
  nofollow:       { title: "Nofollow", field: "isNofollow", width: 80, hozAlign: "center", formatter: boolFormatter },
  xRobotsTag:     { title: "X-Robots-Tag", field: "xRobotsTag", minWidth: 140, width: 180, tooltip: true },
  maxImgPreview:  { title: "Max Image Preview", field: "_maxImgPreview", width: 130, hozAlign: "center", formatter: maxImagePreviewFormatter },

  // Open Graph
  ogTitle:        { title: "og:title", field: "ogTitle", minWidth: 180, widthGrow: 2, tooltip: true },
  ogDesc:         { title: "og:description", field: "ogDescription", minWidth: 180, widthGrow: 2, tooltip: true },
  ogImage:        { title: "og:image", field: "ogImage", minWidth: 200, widthGrow: 2, tooltip: true },
  ogType:         { title: "og:type", field: "ogType", width: 100 },
  ogUrl:          { title: "og:url", field: "ogUrl", minWidth: 200, widthGrow: 2, tooltip: true },
  ogImgW:         { title: "og:image W", field: "ogImageWidth", width: 90, hozAlign: "center", formatter: dimensionFormatter },
  ogImgH:         { title: "og:image H", field: "ogImageHeight", width: 90, hozAlign: "center", formatter: dimensionFormatter },
  ogImgWReal:     { title: "og:image W (Real)", field: "ogImageWidthReal", width: 120, hozAlign: "center", formatter: dimensionFormatter },
  ogImgHReal:     { title: "og:image H (Real)", field: "ogImageHeightReal", width: 120, hozAlign: "center", formatter: dimensionFormatter },
  ogImgRatio:     { title: "og:image Ratio", field: "ogImageRatio", width: 100, hozAlign: "center" },
  ogImgSize:      { title: "og:image Size", field: "ogImageFileSize", width: 100, hozAlign: "right", formatter: sizeFormatter },

  // Dates
  datePub:        { title: "Date Published", field: "datePublished", width: 120 },
  datePubTime:    { title: "Published Time", field: "datePublishedTime", width: 120 },
  dateMod:        { title: "Date Modified", field: "dateModified", width: 120 },
  dateModTime:    { title: "Modified Time", field: "dateModifiedTime", width: 120 },

  // Queue status
  queueStatus: {
    title: "Queue Status", field: "_queueStatus", width: 130, hozAlign: "center",
    mutator: (_value: any, data: any) => {
      if (config.recrawlQueue.includes(data.url)) return "Pending";
      if (data.status === 0 && data.error) return "Error";
      if (data.status >= 400) return "Error";
      return "Done";
    },
    formatter: (cell: any) => {
      const val = cell.getValue();
      if (val === "Done") return '<span style="color:#4ec9b0;font-weight:600">Done</span>';
      if (val === "Pending") return '<span style="color:#dcdcaa;font-weight:600">Pending</span>';
      if (val === "Error") return '<span style="color:#f44747;font-weight:600">Error</span>';
      return "";
    },
  },
} as Record<string, any>;

/* ── Tab → columns mapping ── */

const TAB_COLUMNS: Record<string, any[]> = {
  "Internal":         [COL.address, COL.contentType, COL.statusCode, COL.statusText, COL.title, COL.metaDesc, COL.h1, COL.h2, COL.canonical, COL.ogImage, COL.intLinks, COL.extLinks, COL.wordCount, COL.indexable, COL.responseTime, COL.size],
  "External":         [COL.address, COL.contentType, COL.statusCode, COL.statusText, COL.server, COL.intLinks, COL.extLinks, COL.responseTime, COL.resource, COL.size],
  "Security":         [COL.address, COL.statusCode, COL.server, COL.contentType, COL.xRobotsTag, COL.size],
  "Response Codes":   [COL.address, COL.statusCode, COL.statusText, COL.redirectUrl, COL.server, COL.contentType, COL.responseTime],
  "URL":              [COL.address, COL.statusCode, COL.contentType, COL.size, COL.responseTime],
  "Page Titles":      [COL.address, COL.title, COL.titleLen, COL.statusCode, COL.indexable],
  "Meta Description": [COL.address, COL.metaDesc, COL.metaDescLen, COL.statusCode, COL.indexable],
  "H1":               [COL.address, COL.h1, COL.h1Len, COL.statusCode],
  "H2":               [COL.address, COL.h2, COL.h2Len, COL.statusCode],
  "Content":          [COL.address, COL.wordCount, COL.contentType, COL.size, COL.statusCode, COL.responseTime],
  "Images":           [COL.address, COL.ogImage, COL.ogImgW, COL.ogImgH, COL.ogImgWReal, COL.ogImgHReal, COL.ogImgRatio, COL.ogImgSize, COL.maxImgPreview, COL.statusCode, COL.size],
  "Canonicals":       [COL.address, COL.canonical, COL.statusCode, COL.indexable],
  "Directives":       [COL.address, COL.metaRobots, COL.xRobotsTag, COL.indexable, COL.noindex, COL.nofollow, COL.maxImgPreview, COL.statusCode],
  "JavaScript":       [COL.address, COL.statusCode, COL.size, COL.responseTime],
  "Links":            [COL.address, COL.intLinks, COL.extLinks, COL.uniqueOutlinks, COL.statusCode],
  "Structured Data":  [COL.address, COL.ogTitle, COL.ogDesc, COL.ogType, COL.ogImage, COL.datePub, COL.dateMod, COL.statusCode],
  "Overview":         [COL.address, COL.statusCode, COL.statusText, COL.title, COL.metaDesc, COL.h1, COL.canonical, COL.ogImage, COL.ogImgW, COL.ogImgH, COL.metaRobots, COL.indexable, COL.intLinks, COL.extLinks, COL.wordCount, COL.responseTime, COL.size, COL.datePub, COL.dateMod],
  "Issues":           [COL.address, COL.statusCode, COL.statusText, COL.title, COL.metaDesc, COL.h1, COL.canonical, COL.indexable, COL.noindex],
  "Site Structure":   [COL.address, COL.statusCode, COL.intLinks, COL.extLinks, COL.wordCount, COL.size],
  "Response Times":   [COL.address, COL.responseTime, COL.statusCode, COL.size, COL.server],
  "Recrawl Queue":    [COL.address, COL.queueStatus, COL.statusCode, COL.statusText, COL.contentType, COL.responseTime, COL.size],
};

/* ── Helpers ── */

function getScraperColumns(): any[] {
  return config.scraperRules.flatMap((rule) => [
    {
      title: rule.name,
      field: "_scraper_" + rule.name,
      minWidth: 120,
      widthGrow: 1,
      tooltip: true,
      mutator: (_value: any, data: any) => data.scraper?.[rule.name]?.value ?? "",
    },
    {
      title: rule.name + " appears",
      field: "_scraper_" + rule.name + "_appears",
      width: 100,
      hozAlign: "center" as const,
      mutator: (_value: any, data: any) => data.scraper?.[rule.name]?.appears ?? false,
      formatter: (cell: any) => cell.getValue() ? "Yes" : "",
    },
  ]);
}

function getColumns(tab: string) {
  const base = TAB_COLUMNS[tab] || TAB_COLUMNS["Internal"];
  const scraper = getScraperColumns();
  return scraper.length ? [...base, ...scraper] : base;
}

// Builds the typed ResultsFilter passed to query_results / count_results
// from the current tab + Filter Bar selection + search query + recrawl
// queue. Pure function so it can be unit-tested independent of Tabulator.
function currentFilter(): ResultsFilter {
  return buildResultsFilter({
    tab: props.activeTab,
    filterType: props.filterType,
    searchQuery: props.searchQuery,
    recrawlQueue: config.recrawlQueue,
  });
}

/* ── Lifecycle ── */

onMounted(() => {
  if (!tableRef.value) return;

  table = new Tabulator(tableRef.value, {
    height: "100%",
    layout: "fitDataStretch",
    // Phase-4 remote mode: Tabulator asks Rust for the visible window via
    // ajaxRequestFunc. We piggyback on its ajax pipeline (URL is unused —
    // every fetch routes through the func).
    ajaxURL: "tauri://query_results",
    ajaxRequestFunc: ajaxRequestFunc,
    pagination: true,
    paginationMode: "remote",
    paginationSize: 100,
    progressiveLoad: "scroll",
    progressiveLoadDelay: 200,
    progressiveLoadScrollMargin: 300,
    sortMode: "remote",
    selectableRows: true,
    rowHeader: { formatter: "rownum", hozAlign: "center", width: 40, resizable: false, frozen: true },
    columns: getColumns(props.activeTab),
  });

  table.on("rowSelected", (row: any) => { emit("rowSelect", row.getData() as CrawlResult); });
  table.on("rowDeselected", () => {
    const selected = table?.getSelectedRows();
    if (!selected?.length) emit("rowSelect", null);
  });

  // Plain click → single-select. Modifier click (cmd/ctrl/shift) → keep
  // Tabulator's default toggle so power users can still multi-pick.
  table.on("rowClick", (e: MouseEvent, row: any) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    const others = table?.getSelectedRows().filter((r: any) => r !== row) ?? [];
    if (others.length) {
      for (const r of others) r.deselect();
    }
    if (!row.isSelected()) row.select();
  });

  // Right-click context menu
  table.on("rowContext", (e: MouseEvent, row: any) => {
    e.preventDefault();
    if (!row.isSelected()) {
      table?.deselectRow();
      row.select();
    }
    showContextMenu(e.clientX, e.clientY);
  });
});

onUnmounted(() => {
  if (table) {
    table.destroy();
    table = null;
  }
});

// Tabulator hands us `(url, _config, params)` where params has page, size,
// and (in sortMode=remote) sort: [{ field, dir }]. We translate to the
// ResultsFilter / ResultsSort shape the Rust commands expect, run them in
// parallel, and return the page payload Tabulator's progressive-load loop
// expects: { data, last_page }.
async function ajaxRequestFunc(_url: string, _config: any, params: any): Promise<{ data: any[]; last_page: number }> {
  if (props.sessionId == null) {
    emit("filteredCount", 0);
    return { data: [], last_page: 1 };
  }
  const filter = currentFilter();
  const page = (params?.page ?? 1) - 1;  // Tabulator pages are 1-based; Rust takes 0-based.
  const size = params?.size ?? 100;
  const sortDescriptor = Array.isArray(params?.sort) && params.sort.length > 0 ? params.sort[0] : null;
  const column = sortDescriptor ? sortFieldToColumn(sortDescriptor.field) : null;
  const sort = column
    ? { column, direction: sortDescriptor!.dir === "desc" ? "desc" : "asc" }
    : null;

  try {
    const [rows, total] = await Promise.all([
      invoke<any[]>("query_results", {
        sessionId: props.sessionId,
        page,
        limit: size,
        filter,
        sort,
      }),
      invoke<number>("count_results", { sessionId: props.sessionId, filter }),
    ]);
    emit("filteredCount", total);
    const last_page = Math.max(1, Math.ceil(total / size));
    return { data: rows, last_page };
  } catch (e) {
    console.error("CrawlGrid query failed:", e);
    return { data: [], last_page: 1 };
  }
}

// Force Tabulator to rerun its ajaxRequestFunc — used whenever the filter
// inputs change (tab/filterType/search) or the data may have changed
// underneath us (refreshKey bump from a crawl-progress event or recrawl
// queue mutation).
function refresh() {
  if (!table) return;
  // setData with no args re-issues the ajax request from page 1.
  void table.setData();
}

watch(() => props.activeTab, (tab) => {
  if (!table) return;
  table.setColumns(getColumns(tab));
  refresh();
});
watch(() => props.filterType, refresh);
watch(() => props.searchQuery, refresh);
watch(() => props.refreshKey, refresh);
watch(() => props.sessionId, refresh);
watch(() => config.recrawlQueue.length, refresh);
watch(() => props.selectAll, () => {
  if (table) table.selectRow();
});
</script>

<template>
  <div ref="tableRef" class="crawl-table"></div>
  <Teleport to="body">
    <div v-if="ctxMenu" class="ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }">
      <button class="ctx-item" @click="handleOpenInBrowser">
        Open {{ ctxMenu.count === 1 ? "page" : `${ctxMenu.count} pages` }} in browser
      </button>
      <button class="ctx-item" @click="handleCopyUrls">
        Copy URL{{ ctxMenu.count !== 1 ? "s" : "" }}
      </button>
      <div class="ctx-divider"></div>
      <button class="ctx-item" @click="handleRecrawl">
        Recrawl {{ ctxMenu.count }} URL{{ ctxMenu.count !== 1 ? "s" : "" }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.crawl-table { height: 100%; }

.crawl-table :deep(.tabulator) {
  background: #0c111d;
  border: none;
  font-family: 'Ubuntu', sans-serif;
  font-size: 11px;
  color: rgba(255,255,255,0.7);
}

.crawl-table :deep(.tabulator-header) {
  background: rgba(255,255,255,0.03);
  border-bottom: 1px solid rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.25);
  font-family: 'Ubuntu', sans-serif;
  font-weight: 600;
  font-size: 8px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
}
.crawl-table :deep(.tabulator-header .tabulator-col) {
  background: transparent;
  border-right: 1px solid rgba(255,255,255,0.04);
}
.crawl-table :deep(.tabulator-header .tabulator-col.tabulator-sortable:hover) {
  background: rgba(255,255,255,0.04);
}
.crawl-table :deep(.tabulator-header .tabulator-col .tabulator-col-content) {
  padding: 6px 8px;
}

.crawl-table :deep(.tabulator-tableholder .tabulator-table .tabulator-row) {
  border-bottom: 1px solid rgba(255,255,255,0.04);
  color: rgba(255,255,255,0.7);
  font-family: 'Ubuntu', sans-serif;
  font-size: 11px;
}
.crawl-table :deep(.tabulator-row.tabulator-row-even) { background: #0c111d; }
.crawl-table :deep(.tabulator-row.tabulator-row-odd) { background: #0c111d; }
.crawl-table :deep(.tabulator-row:hover) { background: rgba(86,156,214,0.08) !important; }
.crawl-table :deep(.tabulator-row.tabulator-selected) { background: rgba(86,156,214,0.15) !important; color: #ffffff; }

.crawl-table :deep(.tabulator-cell) {
  padding: 4px 8px;
  border-right: 1px solid rgba(255,255,255,0.04);
}

.crawl-table :deep(.tabulator-row .tabulator-row-header) {
  background: rgba(255,255,255,0.03);
  color: rgba(255,255,255,0.2);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  border-right: 1px solid rgba(255,255,255,0.06);
}

.crawl-table :deep(.tabulator-footer) {
  background: #0c111d;
  border-top: 1px solid rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.25);
}
</style>

<style>
.ctx-menu {
  position: fixed;
  z-index: 9999;
  background: #161b2e;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  padding: 4px;
  min-width: 160px;
}
.ctx-item {
  display: block;
  width: 100%;
  padding: 7px 14px;
  background: none;
  border: none;
  border-radius: 5px;
  color: rgba(255,255,255,0.7);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.1s;
}
.ctx-item:hover {
  background: rgba(86,156,214,0.15);
  color: #ffffff;
}
.ctx-divider {
  height: 1px;
  margin: 4px 0;
  background: rgba(255, 255, 255, 0.06);
}
</style>
