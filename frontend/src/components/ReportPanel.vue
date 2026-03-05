<script setup lang="ts">
import { computed } from "vue";
import type { CrawlResult } from "../types/crawl";

const props = defineProps<{ report: string; results: CrawlResult[] }>();
const emit = defineEmits<{ close: [] }>();

const title = computed(() => {
  const titles: Record<string, string> = {
    overview: "Crawl Overview",
    redirects: "Redirect Chains",
    duplicates: "Duplicate Content",
    orphans: "Orphan Pages",
  };
  return titles[props.report] ?? "Report";
});

const overviewStats = computed(() => {
  const r = props.results;
  const total = r.length;
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let totalTime = 0;
  let totalSize = 0;
  let errors = 0;

  for (const row of r) {
    const statusGroup = row.status ? `${Math.floor(row.status / 100)}xx` : "Error";
    byStatus[statusGroup] = (byStatus[statusGroup] || 0) + 1;

    const rt = row.resourceType || "Other";
    byType[rt] = (byType[rt] || 0) + 1;

    totalTime += row.responseTime || 0;
    totalSize += row.size || 0;
    if (row.error) errors++;
  }

  return {
    total,
    byStatus,
    byType,
    avgTime: total ? Math.round(totalTime / total) : 0,
    totalSize,
    errors,
  };
});

const redirectResults = computed(() =>
  props.results.filter((r) => r.status >= 300 && r.status < 400)
);

const duplicateTitles = computed(() => {
  const titleMap: Record<string, CrawlResult[]> = {};
  for (const r of props.results) {
    if (!r.title) continue;
    if (!titleMap[r.title]) titleMap[r.title] = [];
    titleMap[r.title].push(r);
  }
  return Object.entries(titleMap).filter(([, urls]) => urls.length > 1);
});

const orphanPages = computed(() =>
  // Pages not linked to by any other crawled page (heuristic: no internal links pointing to them)
  // For now, show pages with 0 internal links found on the page itself (placeholder)
  props.results.filter((r) => r.internalLinks === 0 && r.resourceType === "HTML")
);
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="modal report-modal">
      <div class="modal-header">
        <h3>{{ title }}</h3>
        <button class="close-btn" @click="emit('close')">&times;</button>
      </div>

      <div class="modal-body">
        <div v-if="!results.length" class="empty">No crawl data. Run a crawl first.</div>

        <!-- Overview -->
        <template v-else-if="report === 'overview'">
          <div class="stat-grid">
            <div class="stat">
              <span class="stat-value">{{ overviewStats.total }}</span>
              <span class="stat-label">Total URLs</span>
            </div>
            <div class="stat">
              <span class="stat-value">{{ overviewStats.avgTime }}ms</span>
              <span class="stat-label">Avg Response</span>
            </div>
            <div class="stat">
              <span class="stat-value">{{ overviewStats.errors }}</span>
              <span class="stat-label">Errors</span>
            </div>
          </div>

          <h4>By Status Code</h4>
          <div class="breakdown">
            <div v-for="(count, group) in overviewStats.byStatus" :key="group" class="breakdown-row">
              <span class="breakdown-label" :class="'status-' + (group as string).charAt(0)">{{ group }}</span>
              <div class="bar-container">
                <div class="bar" :style="{ width: (count / overviewStats.total * 100) + '%' }"></div>
              </div>
              <span class="breakdown-count">{{ count }}</span>
            </div>
          </div>

          <h4>By Resource Type</h4>
          <div class="breakdown">
            <div v-for="(count, type) in overviewStats.byType" :key="type" class="breakdown-row">
              <span class="breakdown-label">{{ type }}</span>
              <div class="bar-container">
                <div class="bar bar-type" :style="{ width: (count / overviewStats.total * 100) + '%' }"></div>
              </div>
              <span class="breakdown-count">{{ count }}</span>
            </div>
          </div>
        </template>

        <!-- Redirects -->
        <template v-else-if="report === 'redirects'">
          <div v-if="!redirectResults.length" class="empty">No redirects found.</div>
          <table v-else class="report-table">
            <thead>
              <tr><th>URL</th><th>Status</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in redirectResults" :key="r.url">
                <td class="url-cell">{{ r.url }}</td>
                <td class="status-cell">{{ r.status }}</td>
              </tr>
            </tbody>
          </table>
        </template>

        <!-- Duplicates -->
        <template v-else-if="report === 'duplicates'">
          <div v-if="!duplicateTitles.length" class="empty">No duplicate titles found.</div>
          <div v-else v-for="[title, urls] in duplicateTitles" :key="title" class="dup-group">
            <h4 class="dup-title">{{ title }} ({{ urls.length }})</h4>
            <ul>
              <li v-for="u in urls" :key="u.url" class="dup-url">{{ u.url }}</li>
            </ul>
          </div>
        </template>

        <!-- Orphans -->
        <template v-else-if="report === 'orphans'">
          <div v-if="!orphanPages.length" class="empty">No orphan pages detected.</div>
          <table v-else class="report-table">
            <thead>
              <tr><th>URL</th><th>Title</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in orphanPages" :key="r.url">
                <td class="url-cell">{{ r.url }}</td>
                <td>{{ r.title }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.report-modal {
  background: #1a1a2e;
  border: 1px solid #0f3460;
  border-radius: 8px;
  min-width: 600px;
  max-width: 800px;
  max-height: 80vh;
  color: #e0e0e0;
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid #0f3460;
  flex-shrink: 0;
}

.modal-header h3 { margin: 0; font-size: 1rem; }

.close-btn {
  background: none;
  border: none;
  color: #a0a0a0;
  font-size: 1.4rem;
  cursor: pointer;
}

.close-btn:hover { color: #e0e0e0; }

.modal-body {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}

.empty {
  color: #a0a0a0;
  text-align: center;
  padding: 24px;
}

.stat-grid {
  display: flex;
  gap: 16px;
  margin-bottom: 20px;
}

.stat {
  flex: 1;
  background: #16213e;
  border-radius: 6px;
  padding: 16px;
  text-align: center;
}

.stat-value {
  display: block;
  font-size: 1.6rem;
  font-weight: 700;
  color: #e94560;
}

.stat-label {
  font-size: 0.8rem;
  color: #a0a0a0;
}

h4 {
  margin: 16px 0 8px;
  font-size: 0.9rem;
  color: #a0a0a0;
}

.breakdown {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.breakdown-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.85rem;
}

.breakdown-label {
  min-width: 80px;
  font-weight: 600;
}

.status-2 { color: #4caf50; }
.status-3 { color: #ff9800; }
.status-4 { color: #f44336; }
.status-5 { color: #e94560; }
.status-E { color: #e94560; }

.bar-container {
  flex: 1;
  height: 8px;
  background: #16213e;
  border-radius: 4px;
  overflow: hidden;
}

.bar {
  height: 100%;
  background: #4caf50;
  border-radius: 4px;
  min-width: 2px;
}

.bar-type { background: #0f3460; }

.breakdown-count {
  min-width: 40px;
  text-align: right;
  color: #a0a0a0;
}

.report-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.report-table th {
  text-align: left;
  padding: 8px;
  border-bottom: 1px solid #0f3460;
  color: #a0a0a0;
  font-weight: 600;
}

.report-table td {
  padding: 6px 8px;
  border-bottom: 1px solid #0f3460;
}

.url-cell {
  max-width: 400px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-cell { text-align: center; }

.dup-group { margin-bottom: 12px; }

.dup-title {
  color: #ff9800;
  margin: 0 0 4px;
  font-size: 0.85rem;
}

.dup-url {
  font-size: 0.8rem;
  color: #a0a0a0;
  padding: 2px 0;
  list-style: none;
}

.dup-group ul { margin: 0; padding: 0 0 0 12px; }
</style>
