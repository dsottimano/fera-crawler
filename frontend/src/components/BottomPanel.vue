<script setup lang="ts">
import { ref, computed } from "vue";
import type { CrawlResult } from "../types/crawl";

const props = defineProps<{ selectedResult: CrawlResult | null }>();
const activeTab = ref("URL Details");
const bottomTabs = ["URL Details", "Inlinks", "Outlinks", "Image Details", "Resources", "SERP Snippet", "Rendered Page", "View Source", "HTTP Headers"];

const detailRows = computed(() => {
  const r = props.selectedResult;
  if (!r) return [];
  return [
    { name: "URL", value: r.url }, { name: "Status Code", value: String(r.status) },
    { name: "Content Type", value: r.contentType }, { name: "Resource Type", value: r.resourceType },
    { name: "Server", value: r.serverHeader ?? "" },
    ...(r.redirectUrl ? [{ name: "Redirect URL", value: r.redirectUrl }] : []),
    { name: "Title", value: r.title }, { name: "H1", value: r.h1 },
    { name: "Meta Description", value: r.metaDescription }, { name: "Canonical", value: r.canonical },
    { name: "Internal Links", value: String(r.internalLinks) }, { name: "External Links", value: String(r.externalLinks) },
    { name: "Response Time", value: r.responseTime + "ms" }, { name: "Size", value: formatSize(r.size) },
    ...(r.error ? [{ name: "Error", value: r.error }] : []),
  ];
});

const headerRows = computed(() => {
  const r = props.selectedResult;
  if (!r?.responseHeaders) return [];
  return Object.entries(r.responseHeaders)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ name, value }));
});

function formatSize(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}
</script>

<template>
  <div class="bottom-panel">
    <div class="bottom-tabs">
      <button v-for="tab in bottomTabs" :key="tab" class="bottom-tab" :class="{ 'bottom-tab--active': activeTab === tab }" @click="activeTab = tab">{{ tab }}</button>
    </div>
    <div class="bottom-content">
      <div v-if="activeTab === 'URL Details'" class="detail-content">
        <table v-if="selectedResult" class="detail-table">
          <thead><tr><th>NAME</th><th>VALUE</th></tr></thead>
          <tbody><tr v-for="row in detailRows" :key="row.name"><td class="detail-name">{{ row.name }}</td><td class="detail-value">{{ row.value }}</td></tr></tbody>
        </table>
        <div v-else class="empty-detail">No URL selected</div>
      </div>
      <div v-else-if="activeTab === 'HTTP Headers'" class="detail-content">
        <table v-if="selectedResult && headerRows.length" class="detail-table">
          <thead><tr><th>HEADER</th><th>VALUE</th></tr></thead>
          <tbody><tr v-for="row in headerRows" :key="row.name"><td class="detail-name">{{ row.name }}</td><td class="detail-value">{{ row.value }}</td></tr></tbody>
        </table>
        <div v-else class="empty-detail">{{ selectedResult ? 'No response headers captured' : 'No URL selected' }}</div>
      </div>
      <div v-else class="detail-content"><div class="empty-detail">{{ activeTab }}</div></div>
    </div>
    <div class="bottom-status">Selected Cells: 0 &nbsp;&nbsp; Total: {{ selectedResult ? 1 : 0 }}</div>
  </div>
</template>

<style scoped>
.bottom-panel {
  display: flex; flex-direction: column; background: #0c111d;
  border-top: 1px solid rgba(255,255,255,0.06); min-height: 140px; height: 180px;
}
.bottom-tabs {
  display: flex; flex-shrink: 0; overflow-x: auto;
  border-bottom: 1px solid rgba(255,255,255,0.06); gap: 0;
  background: rgba(255,255,255,0.02); padding: 0 4px;
}
.bottom-tab {
  padding: 6px 12px; border: none; background: transparent;
  color: rgba(255,255,255,0.3); font-size: 10px; font-weight: 600;
  letter-spacing: 0.3px; cursor: pointer; white-space: nowrap;
  border-bottom: 2px solid transparent; transition: all 0.15s;
}
.bottom-tab:hover { color: rgba(255,255,255,0.6); }
.bottom-tab--active { color: #569cd6; border-bottom-color: #569cd6; }
.bottom-content { flex: 1; overflow: auto; }
.detail-content { height: 100%; }
.detail-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.detail-table th {
  text-align: left; padding: 5px 10px; background: rgba(255,255,255,0.03);
  border-bottom: 1px solid rgba(255,255,255,0.06); font-weight: 700;
  color: rgba(255,255,255,0.2); font-size: 8px; letter-spacing: 1.2px; position: sticky; top: 0;
}
.detail-table td { padding: 3px 10px; border-bottom: 1px solid rgba(255,255,255,0.03); }
.detail-name { width: 130px; color: rgba(255,255,255,0.35); font-weight: 600; font-size: 10px; letter-spacing: 0.3px; }
.detail-value { color: #ffffff; word-break: break-all; font-family: 'Ubuntu Mono', monospace; font-size: 11px; }
.empty-detail { display: flex; align-items: center; justify-content: center; height: 100%; color: rgba(255,255,255,0.12); font-size: 12px; letter-spacing: 1px; }
.bottom-status { padding: 3px 12px; font-size: 9px; color: rgba(255,255,255,0.15); background: #0c111d; border-top: 1px solid rgba(255,255,255,0.04); flex-shrink: 0; letter-spacing: 0.5px; }
</style>
