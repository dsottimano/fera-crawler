<script setup lang="ts">
import { ref, computed } from "vue";
import type { CrawlResult } from "../types/crawl";

const props = defineProps<{ selectedResult: CrawlResult | null }>();
const activeTab = ref("URL Details");
const bottomTabs = ["URL Details", "Directives", "Open Graph", "Dates", "Outlinks", "Meta Tags", "HTTP Headers", "Scraper"];

const detailRows = computed(() => {
  const r = props.selectedResult;
  if (!r) return [];
  return [
    { name: "URL", value: r.url },
    { name: "Status Code", value: String(r.status) },
    { name: "Content Type", value: r.contentType },
    { name: "Resource Type", value: r.resourceType },
    { name: "Server", value: r.serverHeader ?? "" },
    ...(r.redirectUrl ? [{ name: "Redirect URL", value: r.redirectUrl }] : []),
    { name: "Title", value: r.title },
    { name: "H1", value: r.h1 },
    { name: "H2", value: r.h2 },
    { name: "Meta Description", value: r.metaDescription },
    { name: "Canonical", value: r.canonical },
    { name: "Word Count", value: String(r.wordCount) },
    { name: "Internal Links", value: String(r.internalLinks) },
    { name: "External Links", value: String(r.externalLinks) },
    { name: "Unique Outlinks", value: String(r.outlinks?.length ?? 0) },
    { name: "Response Time", value: r.responseTime + "ms" },
    { name: "Size", value: formatSize(r.size) },
    ...(r.error ? [{ name: "Error", value: r.error }] : []),
  ];
});

const directiveRows = computed(() => {
  const r = props.selectedResult;
  if (!r) return [];
  return [
    { name: "Meta Robots", value: r.metaRobots || "(none)" },
    { name: "Meta Googlebot", value: r.metaGooglebot || "(none)" },
    { name: "X-Robots-Tag", value: r.xRobotsTag || "(none)" },
    { name: "Indexable", value: r.isIndexable ? "Yes" : "No" },
    { name: "Noindex", value: r.isNoindex ? "Yes" : "No" },
    { name: "Nofollow", value: r.isNofollow ? "Yes" : "No" },
    { name: "Canonical", value: r.canonical || "(none)" },
  ];
});

const ogRows = computed(() => {
  const r = props.selectedResult;
  if (!r) return [];
  return [
    { name: "og:title", value: r.ogTitle || "" },
    { name: "og:description", value: r.ogDescription || "" },
    { name: "og:type", value: r.ogType || "" },
    { name: "og:url", value: r.ogUrl || "" },
    { name: "og:image", value: r.ogImage || "" },
    { name: "og:image Width", value: r.ogImageWidth ? r.ogImageWidth + "px" : "" },
    { name: "og:image Height", value: r.ogImageHeight ? r.ogImageHeight + "px" : "" },
    { name: "og:image Width (Real)", value: r.ogImageWidthReal ? r.ogImageWidthReal + "px" : "" },
    { name: "og:image Height (Real)", value: r.ogImageHeightReal ? r.ogImageHeightReal + "px" : "" },
    { name: "og:image Ratio", value: r.ogImageRatio ? String(r.ogImageRatio) : "" },
    { name: "og:image File Size", value: r.ogImageFileSize ? formatSize(r.ogImageFileSize) : "" },
  ];
});

const dateRows = computed(() => {
  const r = props.selectedResult;
  if (!r) return [];
  return [
    { name: "Date Published", value: r.datePublished || "(none)" },
    { name: "Published Time", value: r.datePublishedTime || "" },
    { name: "Date Modified", value: r.dateModified || "(none)" },
    { name: "Modified Time", value: r.dateModifiedTime || "" },
  ];
});

const scraperRows = computed(() => {
  const r = props.selectedResult;
  if (!r?.scraper) return [];
  return Object.entries(r.scraper).flatMap(([name, data]) => [
    { name, value: data.value || "(empty)" },
    { name: name + " appears", value: data.appears ? "Yes" : "No" },
  ]);
});

const headerRows = computed(() => {
  const r = props.selectedResult;
  if (!r?.responseHeaders) return [];
  return Object.entries(r.responseHeaders)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ name, value }));
});

const metaTagRows = computed(() => {
  const r = props.selectedResult;
  if (!r?.metaTags?.length) return [];
  return r.metaTags.map((t) => ({
    name: t.name || t.property,
    property: t.property,
    value: t.content,
  }));
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
      <!-- URL Details -->
      <div v-if="activeTab === 'URL Details'" class="detail-content">
        <table v-if="selectedResult" class="detail-table">
          <thead><tr><th>NAME</th><th>VALUE</th></tr></thead>
          <tbody><tr v-for="row in detailRows" :key="row.name"><td class="detail-name">{{ row.name }}</td><td class="detail-value">{{ row.value }}</td></tr></tbody>
        </table>
        <div v-else class="empty-detail">No URL selected</div>
      </div>

      <!-- Directives -->
      <div v-else-if="activeTab === 'Directives'" class="detail-content">
        <table v-if="selectedResult" class="detail-table">
          <thead><tr><th>DIRECTIVE</th><th>VALUE</th></tr></thead>
          <tbody>
            <tr v-for="row in directiveRows" :key="row.name">
              <td class="detail-name">{{ row.name }}</td>
              <td class="detail-value" :class="{ 'val-warn': row.name === 'Noindex' && row.value === 'Yes', 'val-ok': row.name === 'Indexable' && row.value === 'Yes' }">{{ row.value }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty-detail">No URL selected</div>
      </div>

      <!-- Open Graph -->
      <div v-else-if="activeTab === 'Open Graph'" class="detail-content">
        <table v-if="selectedResult" class="detail-table">
          <thead><tr><th>PROPERTY</th><th>VALUE</th></tr></thead>
          <tbody><tr v-for="row in ogRows" :key="row.name"><td class="detail-name">{{ row.name }}</td><td class="detail-value">{{ row.value }}</td></tr></tbody>
        </table>
        <div v-else class="empty-detail">No URL selected</div>
      </div>

      <!-- Dates -->
      <div v-else-if="activeTab === 'Dates'" class="detail-content">
        <table v-if="selectedResult" class="detail-table">
          <thead><tr><th>FIELD</th><th>VALUE</th></tr></thead>
          <tbody><tr v-for="row in dateRows" :key="row.name"><td class="detail-name">{{ row.name }}</td><td class="detail-value">{{ row.value }}</td></tr></tbody>
        </table>
        <div v-else class="empty-detail">No URL selected</div>
      </div>

      <!-- Outlinks -->
      <div v-else-if="activeTab === 'Outlinks'" class="detail-content">
        <table v-if="selectedResult && selectedResult.outlinks?.length" class="detail-table">
          <thead><tr><th>#</th><th>URL</th></tr></thead>
          <tbody>
            <tr v-for="(link, i) in selectedResult.outlinks" :key="i">
              <td class="detail-name" style="width:40px;text-align:center">{{ i + 1 }}</td>
              <td class="detail-value">{{ link }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty-detail">{{ selectedResult ? 'No outlinks' : 'No URL selected' }}</div>
      </div>

      <!-- Meta Tags -->
      <div v-else-if="activeTab === 'Meta Tags'" class="detail-content">
        <table v-if="selectedResult && metaTagRows.length" class="detail-table">
          <thead><tr><th>NAME / PROPERTY</th><th>CONTENT</th></tr></thead>
          <tbody>
            <tr v-for="(row, i) in metaTagRows" :key="i">
              <td class="detail-name">{{ row.name }}<span v-if="row.property" class="detail-prop"> ({{ row.property }})</span></td>
              <td class="detail-value">{{ row.value }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty-detail">{{ selectedResult ? 'No meta tags found' : 'No URL selected' }}</div>
      </div>

      <!-- HTTP Headers -->
      <div v-else-if="activeTab === 'HTTP Headers'" class="detail-content">
        <table v-if="selectedResult && headerRows.length" class="detail-table">
          <thead><tr><th>HEADER</th><th>VALUE</th></tr></thead>
          <tbody><tr v-for="row in headerRows" :key="row.name"><td class="detail-name">{{ row.name }}</td><td class="detail-value">{{ row.value }}</td></tr></tbody>
        </table>
        <div v-else class="empty-detail">{{ selectedResult ? 'No response headers captured' : 'No URL selected' }}</div>
      </div>

      <!-- Scraper -->
      <div v-else-if="activeTab === 'Scraper'" class="detail-content">
        <table v-if="selectedResult && scraperRows.length" class="detail-table">
          <thead><tr><th>RULE</th><th>VALUE</th></tr></thead>
          <tbody><tr v-for="row in scraperRows" :key="row.name"><td class="detail-name">{{ row.name }}</td><td class="detail-value">{{ row.value }}</td></tr></tbody>
        </table>
        <div v-else class="empty-detail">No scraper data</div>
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
.detail-prop { color: rgba(255,255,255,0.2); font-size: 9px; }
.val-warn { color: #f44747 !important; font-weight: 600; }
.val-ok { color: #4ec9b0 !important; font-weight: 600; }
.empty-detail { display: flex; align-items: center; justify-content: center; height: 100%; color: rgba(255,255,255,0.12); font-size: 12px; letter-spacing: 1px; }
.bottom-status { padding: 3px 12px; font-size: 9px; color: rgba(255,255,255,0.15); background: #0c111d; border-top: 1px solid rgba(255,255,255,0.04); flex-shrink: 0; letter-spacing: 0.5px; }
</style>
