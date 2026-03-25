<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";
import { TabulatorFull as Tabulator } from "tabulator-tables";
import type { CrawlResult } from "../types/crawl";
import "tabulator-tables/dist/css/tabulator_midnight.min.css";

const props = defineProps<{ results: CrawlResult[]; activeTab: string }>();
const emit = defineEmits<{ rowSelect: [result: CrawlResult | null] }>();

const tableRef = ref<HTMLDivElement>();
let table: any = null;  // Tabulator instance — using any for method access (.on, .setColumns)

/* ── Shared formatters ── */

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
  if (s === 404) return "Not Found";
  if (s === 429) return "Too Many Requests";
  if (s >= 500) return "Server Error";
  if (s >= 400) return "Client Error";
  if (row.error) return "Error";
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

function titleLengthFormatter(cell: any) {
  const val = (cell.getValue() as string) || "";
  return val.length ? String(val.length) : "";
}

function descLengthFormatter(cell: any) {
  const val = (cell.getValue() as string) || "";
  return val.length ? String(val.length) : "";
}

/* ── Column definitions pool ── */

const COL = {
  address:      { title: "Address", field: "url", minWidth: 300, widthGrow: 3, tooltip: true },
  contentType:  { title: "Content Type", field: "contentType", minWidth: 140, width: 160 },
  statusCode:   { title: "Status Code", field: "status", width: 90, hozAlign: "center", formatter: statusCodeFormatter },
  statusText:   { title: "Status", field: "_statusText", width: 120, formatter: statusTextFormatter },
  title:        { title: "Title 1", field: "title", minWidth: 200, widthGrow: 2, tooltip: true },
  titleLen:     { title: "Title Length", field: "title", width: 100, hozAlign: "center", formatter: titleLengthFormatter },
  h1:           { title: "H1", field: "h1", minWidth: 200, widthGrow: 2, tooltip: true },
  h1Len:        { title: "H1 Length", field: "h1", width: 90, hozAlign: "center", formatter: (cell: any) => { const v = (cell.getValue() as string) || ""; return v.length ? String(v.length) : ""; } },
  metaDesc:     { title: "Meta Description", field: "metaDescription", minWidth: 200, widthGrow: 2, tooltip: true },
  metaDescLen:  { title: "Meta Desc Length", field: "metaDescription", width: 110, hozAlign: "center", formatter: descLengthFormatter },
  canonical:    { title: "Canonical", field: "canonical", minWidth: 200, widthGrow: 2, tooltip: true },
  intLinks:     { title: "Int. Links", field: "internalLinks", width: 80, hozAlign: "center" },
  extLinks:     { title: "Ext. Links", field: "externalLinks", width: 80, hozAlign: "center" },
  responseTime: { title: "Response Time", field: "responseTime", width: 110, hozAlign: "right", formatter: responseTimeFormatter },
  resource:     { title: "Resource", field: "resourceType", width: 90 },
  size:         { title: "Size", field: "size", width: 80, hozAlign: "right", formatter: sizeFormatter },
  server:       { title: "Server", field: "serverHeader", minWidth: 100, width: 120, tooltip: true },
  redirectUrl:  { title: "Redirect URL", field: "redirectUrl", minWidth: 200, widthGrow: 2, tooltip: true },
} as Record<string, any>;

/* ── Tab → columns mapping ── */

const TAB_COLUMNS: Record<string, any[]> = {
  "Internal":         [COL.address, COL.contentType, COL.statusCode, COL.statusText, COL.server, COL.title, COL.h1, COL.metaDesc, COL.canonical, COL.intLinks, COL.extLinks, COL.responseTime, COL.resource, COL.size],
  "External":         [COL.address, COL.contentType, COL.statusCode, COL.statusText, COL.server, COL.intLinks, COL.extLinks, COL.responseTime, COL.resource, COL.size],
  "Security":         [COL.address, COL.statusCode, COL.server, COL.contentType, COL.size],
  "Response Codes":   [COL.address, COL.statusCode, COL.statusText, COL.redirectUrl, COL.server, COL.contentType, COL.responseTime],
  "URL":              [COL.address, COL.statusCode, COL.contentType, COL.size, COL.responseTime],
  "Page Titles":      [COL.address, COL.title, COL.titleLen, COL.statusCode],
  "Meta Description": [COL.address, COL.metaDesc, COL.metaDescLen, COL.statusCode],
  "H1":               [COL.address, COL.h1, COL.h1Len, COL.statusCode],
  "H2":               [COL.address, COL.statusCode],
  "Content":          [COL.address, COL.contentType, COL.size, COL.statusCode, COL.responseTime],
  "Images":           [COL.address, COL.statusCode, COL.size, COL.responseTime],
  "Canonicals":       [COL.address, COL.canonical, COL.statusCode],
  "Directives":       [COL.address, COL.statusCode],
  "JavaScript":       [COL.address, COL.statusCode, COL.size, COL.responseTime],
  "Links":            [COL.address, COL.intLinks, COL.extLinks, COL.statusCode],
  "Structured Data":  [COL.address, COL.statusCode],
  "Overview":         [COL.address, COL.contentType, COL.statusCode, COL.statusText, COL.server, COL.redirectUrl, COL.title, COL.h1, COL.metaDesc, COL.canonical, COL.intLinks, COL.extLinks, COL.responseTime, COL.resource, COL.size],
  "Issues":           [COL.address, COL.statusCode, COL.statusText, COL.title, COL.metaDesc, COL.h1],
  "Site Structure":   [COL.address, COL.statusCode, COL.intLinks, COL.extLinks, COL.size],
  "Response Times":   [COL.address, COL.responseTime, COL.statusCode, COL.size],
};

/* ── Tab → row filter ── */

function filterForTab(tab: string): ((r: CrawlResult) => boolean) {
  switch (tab) {
    case "Internal":
      return () => true; // TODO: filter to same-domain when we track origin
    case "External":
      return () => true; // TODO: filter to external-only
    case "Response Codes":
      return () => true;
    case "Page Titles":
      return (r) => r.resourceType === "HTML";
    case "Meta Description":
      return (r) => r.resourceType === "HTML";
    case "H1":
      return (r) => r.resourceType === "HTML";
    case "H2":
      return (r) => r.resourceType === "HTML";
    case "Content":
      return (r) => r.resourceType === "HTML";
    case "Canonicals":
      return (r) => r.resourceType === "HTML";
    case "Directives":
      return (r) => r.resourceType === "HTML";
    case "Images":
      return (r) => r.resourceType === "Image";
    case "JavaScript":
      return (r) => r.resourceType === "JavaScript";
    case "CSS":
      return (r) => r.resourceType === "CSS";
    case "Issues":
      return (r) => !r.title || !r.h1 || !r.metaDescription || r.status >= 400;
    case "Response Times":
      return () => true;
    default:
      return () => true;
  }
}

/* ── Helpers ── */

function getColumns(tab: string) {
  return TAB_COLUMNS[tab] || TAB_COLUMNS["Internal"];
}

function getFilteredData(tab: string) {
  const filter = filterForTab(tab);
  return props.results.filter(filter);
}

/* ── Lifecycle ── */

onMounted(() => {
  if (!tableRef.value) return;

  table = new Tabulator(tableRef.value, {
    data: getFilteredData(props.activeTab),
    reactiveData: false,
    height: "100%",
    layout: "fitDataStretch",
    virtualDom: true,
    selectableRows: 1,
    rowHeader: { formatter: "rownum", hozAlign: "center", width: 40, resizable: false, frozen: true },
    columns: getColumns(props.activeTab),
  });

  table.on("rowSelected", (row: any) => { emit("rowSelect", row.getData() as CrawlResult); });
  table.on("rowDeselected", () => { emit("rowSelect", null); });
});

onUnmounted(() => {
  if (table) {
    table.destroy();
    table = null;
  }
});

// When results change, refresh data with current tab filter
watch(() => props.results.length, () => {
  if (table) table.setData(getFilteredData(props.activeTab));
});

// When tab changes, swap columns and re-filter data
watch(() => props.activeTab, (tab) => {
  if (!table) return;
  table.setColumns(getColumns(tab));
  table.setData(getFilteredData(tab));
});
</script>

<template>
  <div ref="tableRef" class="crawl-table"></div>
</template>

<style scoped>
.crawl-table { height: 100%; }

/* ── Grid: bg-base for ALL rows, no alternating stripe ── */
.crawl-table :deep(.tabulator) {
  background: #0c111d;
  border: none;
  font-family: 'Ubuntu', sans-serif;
  font-size: 11px;
  color: rgba(255,255,255,0.7);
}

/* Header: bg-raised, type-micro */
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

/* Rows: FLAT bg-base for both even and odd — NO alternating */
.crawl-table :deep(.tabulator-tableholder .tabulator-table .tabulator-row) {
  border-bottom: 1px solid rgba(255,255,255,0.04);
  color: rgba(255,255,255,0.7);
  font-family: 'Ubuntu', sans-serif;
  font-size: 11px;
}
.crawl-table :deep(.tabulator-row.tabulator-row-even) {
  background: #0c111d;
}
.crawl-table :deep(.tabulator-row.tabulator-row-odd) {
  background: #0c111d;
}

/* Hover: bg-hover */
.crawl-table :deep(.tabulator-row:hover) {
  background: rgba(86,156,214,0.08) !important;
}

/* Selected: bg-selected, text-primary */
.crawl-table :deep(.tabulator-row.tabulator-selected) {
  background: rgba(86,156,214,0.15) !important;
  color: #ffffff;
}

/* Cells: border-subtle */
.crawl-table :deep(.tabulator-cell) {
  padding: 4px 8px;
  border-right: 1px solid rgba(255,255,255,0.04);
}

/* Row number column */
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
