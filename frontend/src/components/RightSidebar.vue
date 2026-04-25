<script setup lang="ts">
import { computed, ref } from "vue";
import type { CrawlResult } from "../types/crawl";
import { useSettings } from "../composables/useSettings";
import { useConfig } from "../composables/useConfig";

const props = defineProps<{ results: CrawlResult[] }>();
const emit = defineEmits<{ "edit-settings": [] }>();

const internalTypes = ["HTML", "JavaScript", "CSS", "Images", "Media", "Fonts", "XML", "PDF", "Other", "Unknown"] as const;
const externalTypes = ["HTML", "JavaScript", "CSS", "Images"] as const;

// ── Tabs ──────────────────────────────────────────────────────────────────
type TabKey = "stats" | "config";
const TAB_STORAGE_KEY = "fera-right-sidebar-tab";
const initialTab: TabKey = (() => {
  try {
    const v = localStorage.getItem(TAB_STORAGE_KEY);
    return v === "config" ? "config" : "stats";
  } catch { return "stats"; }
})();
const activeTab = ref<TabKey>(initialTab);
function selectTab(tab: TabKey) {
  activeTab.value = tab;
  try { localStorage.setItem(TAB_STORAGE_KEY, tab); } catch {}
}

// ── Stats tab ─────────────────────────────────────────────────────────────
const internalCounts = computed(() => {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const r of props.results) {
    const rt = r.resourceType === "Image" ? "Images" : r.resourceType === "Font" ? "Fonts" : r.resourceType;
    counts[rt] = (counts[rt] || 0) + 1;
    total++;
  }
  return { counts, total };
});

const externalCounts = computed(() => ({ counts: {} as Record<string, number>, total: 0 }));

function pct(count: number, total: number): string {
  if (!total) return "0%";
  return (count / total * 100).toFixed(1) + "%";
}

const chartColors: Record<string, string> = {
  HTML: "#569cd6", JavaScript: "#4ec9b0", CSS: "#dcdcaa", Images: "#c586c0",
  Other: "#d7ba7d", Fonts: "#9cdcfe", PDF: "#f44747", Unknown: "#6a7a8a",
  Media: "#ce9178", XML: "#b5cea8",
};

const donutSegments = computed(() => {
  const { counts, total } = internalCounts.value;
  if (!total) return [];
  const segs: { type: string; count: number; pct: number; color: string }[] = [];
  for (const [type, count] of Object.entries(counts)) {
    if (count > 0) segs.push({ type, count, pct: count / total, color: chartColors[type] || "#6a7a8a" });
  }
  segs.sort((a, b) => b.count - a.count);
  return segs;
});

const donutPaths = computed(() => {
  const segs = donutSegments.value;
  if (!segs.length) return [];
  const paths: { d: string; color: string }[] = [];
  let cum = -90;
  const cx = 100, cy = 100, r = 70, ir = 48;
  for (const seg of segs) {
    const a = seg.pct * 360;
    const sr = (cum * Math.PI) / 180, er = ((cum + a) * Math.PI) / 180;
    const x1 = cx + r * Math.cos(sr), y1 = cy + r * Math.sin(sr);
    const x2 = cx + r * Math.cos(er), y2 = cy + r * Math.sin(er);
    const ix1 = cx + ir * Math.cos(er), iy1 = cy + ir * Math.sin(er);
    const ix2 = cx + ir * Math.cos(sr), iy2 = cy + ir * Math.sin(sr);
    const la = a > 180 ? 1 : 0;
    paths.push({ d: `M ${x1} ${y1} A ${r} ${r} 0 ${la} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${ir} ${ir} 0 ${la} 0 ${ix2} ${iy2} Z`, color: seg.color });
    cum += a;
  }
  return paths;
});

// ── Config tab ────────────────────────────────────────────────────────────
const { settings } = useSettings();
const { config } = useConfig();

// Roll up the active stealth tier the way probeMatrix.ts maps it, so the
// summary uses the same vocabulary the user sees in Probe results.
const stealthTier = computed<string>(() => {
  const s = settings.value.stealth;
  if (!s.enabled) return "off";
  if (!s.canvasNoise && !s.userAgentData) return "tier-1";
  return "tier-2";
});

const customHeaderCount = computed(() => Object.keys(config.customHeaders).length);
</script>

<template>
  <div class="right-sidebar">
    <div class="sidebar-tabs">
      <button class="sidebar-tab" :class="{ 'sidebar-tab--active': activeTab === 'stats' }" @click="selectTab('stats')">Stats</button>
      <button class="sidebar-tab" :class="{ 'sidebar-tab--active': activeTab === 'config' }" @click="selectTab('config')">Config</button>
    </div>

    <!-- ── Stats tab ── -->
    <template v-if="activeTab === 'stats'">
      <div class="resource-tree">
        <table class="tree-table">
          <thead><tr><th></th><th class="col-urls">URLS</th><th class="col-pct">% TOTAL</th></tr></thead>
          <tbody>
            <tr class="section-header"><td>&#x25BC; Internal</td><td></td><td></td></tr>
            <tr class="tree-row tree-row--hl"><td class="indent-1">All</td><td class="col-urls">{{ internalCounts.total }}</td><td class="col-pct">100%</td></tr>
            <tr v-for="type in internalTypes" :key="'i-'+type" class="tree-row"><td class="indent-2">{{ type }}</td><td class="col-urls">{{ internalCounts.counts[type] || 0 }}</td><td class="col-pct">{{ pct(internalCounts.counts[type] || 0, internalCounts.total) }}</td></tr>
            <tr class="section-header"><td>&#x25BC; External</td><td></td><td></td></tr>
            <tr class="tree-row"><td class="indent-1">All</td><td class="col-urls">{{ externalCounts.total }}</td><td class="col-pct">{{ externalCounts.total ? '100%' : '0%' }}</td></tr>
            <tr v-for="type in externalTypes" :key="'e-'+type" class="tree-row"><td class="indent-2">{{ type }}</td><td class="col-urls">{{ externalCounts.counts[type] || 0 }}</td><td class="col-pct">{{ pct(externalCounts.counts[type] || 0, externalCounts.total) }}</td></tr>
          </tbody>
        </table>
      </div>
      <div v-if="internalCounts.total > 0" class="chart-section">
        <div class="chart-title">INTERNAL</div>
        <div class="chart-container">
          <svg viewBox="0 0 200 200" class="donut-chart">
            <circle cx="100" cy="100" r="70" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="22" />
            <path v-for="(seg, i) in donutPaths" :key="i" :d="seg.d" :fill="seg.color" stroke="#0c111d" stroke-width="1.5" />
          </svg>
          <div class="chart-legend">
            <div v-for="seg in donutSegments" :key="seg.type" class="legend-item">
              <span class="legend-dot" :style="{ background: seg.color }"></span>
              {{ seg.type }}
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ── Config tab — read-only summary of active settings ── -->
    <div v-else class="config-summary">
      <div class="config-section">
        <div class="config-section-title">CRAWL</div>
        <div class="config-row"><span class="config-label">Mode</span><span class="config-value">{{ settings.crawling.mode }}</span></div>
        <div v-if="settings.crawling.mode === 'list'" class="config-row"><span class="config-label">List size</span><span class="config-value">{{ config.urls.length.toLocaleString() }} URLs</span></div>
        <div class="config-row"><span class="config-label">Concurrency</span><span class="config-value">{{ settings.crawling.concurrency }}</span></div>
        <div class="config-row"><span class="config-label">Max requests</span><span class="config-value">{{ settings.crawling.maxRequests || '∞' }}</span></div>
        <div class="config-row"><span class="config-label">Delay</span><span class="config-value">{{ settings.crawling.delay }}ms</span></div>
        <div class="config-row"><span class="config-label">Robots.txt</span><span class="config-value" :class="{ 'config-value--off': !settings.crawling.respectRobots }">{{ settings.crawling.respectRobots ? 'Respect' : 'Ignore' }}</span></div>
      </div>

      <div class="config-section">
        <div class="config-section-title">PERFORMANCE</div>
        <div class="config-row"><span class="config-label">Per-host delay</span><span class="config-value">{{ settings.performance.perHostDelay }}ms</span></div>
        <div class="config-row"><span class="config-label">Per-host concurrency</span><span class="config-value">{{ settings.performance.perHostConcurrency }}</span></div>
        <div class="config-row"><span class="config-label">Session warmup</span><span class="config-value" :class="{ 'config-value--off': !settings.performance.sessionWarmup }">{{ settings.performance.sessionWarmup ? 'On' : 'Off' }}</span></div>
        <div class="config-row"><span class="config-label">Auto-probe on block</span><span class="config-value" :class="{ 'config-value--off': !settings.performance.autoProbeOnBlock }">{{ settings.performance.autoProbeOnBlock ? 'On' : 'Off' }}</span></div>
      </div>

      <div class="config-section">
        <div class="config-section-title">STEALTH</div>
        <div class="config-row">
          <span class="config-label">Tier</span>
          <span class="config-value" :class="{ 'config-value--off': stealthTier === 'off' }">{{ stealthTier }}</span>
        </div>
        <div v-if="settings.stealth.userAgent" class="config-row">
          <span class="config-label">UA override</span>
          <span class="config-value config-mono" :title="settings.stealth.userAgent">{{ settings.stealth.userAgent.length > 22 ? settings.stealth.userAgent.slice(0, 20) + '…' : settings.stealth.userAgent }}</span>
        </div>
      </div>

      <div class="config-section">
        <div class="config-section-title">BROWSER</div>
        <div class="config-row"><span class="config-label">Headless</span><span class="config-value">{{ settings.authentication.headless ? 'Yes' : 'No' }}</span></div>
      </div>

      <div class="config-section">
        <div class="config-section-title">EXTRACTION</div>
        <div class="config-row"><span class="config-label">Capture vitals</span><span class="config-value" :class="{ 'config-value--off': !settings.extraction.captureVitals }">{{ settings.extraction.captureVitals ? 'On' : 'Off' }}</span></div>
        <div class="config-row"><span class="config-label">OG:image download</span><span class="config-value" :class="{ 'config-value--off': !settings.extraction.downloadOgImage }">{{ settings.extraction.downloadOgImage ? 'On' : 'Off' }}</span></div>
        <div class="config-row"><span class="config-label">Scraper rules</span><span class="config-value">{{ config.scraperRules.length }}</span></div>
        <div v-if="customHeaderCount > 0" class="config-row"><span class="config-label">Custom headers</span><span class="config-value">{{ customHeaderCount }}</span></div>
      </div>

      <div class="config-actions">
        <button class="btn-edit-settings" title="Open the full settings panel to edit any of these values" @click="emit('edit-settings')">
          &#x2699; Edit settings
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.right-sidebar {
  background: #0c111d;
  border-left: 1px solid rgba(255,255,255,0.06);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  width: 250px;
  min-width: 210px;
  flex-shrink: 0;
}

/* ── Tabs ── */
.sidebar-tabs {
  display: flex;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  flex-shrink: 0;
}
.sidebar-tab {
  flex: 1;
  padding: 8px 12px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: rgba(255,255,255,0.3);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
}
.sidebar-tab:hover {
  color: rgba(255,255,255,0.6);
}
.sidebar-tab--active {
  color: #569cd6;
  border-bottom-color: #569cd6;
}

/* ── Stats tab ── */
.resource-tree { flex: 1; overflow-y: auto; }
.tree-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.tree-table th {
  text-align: right; padding: 4px 8px; font-weight: 700; color: rgba(255,255,255,0.2);
  border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 8px; letter-spacing: 1.2px;
}
.tree-table th:first-child { text-align: left; }
.section-header td {
  padding: 8px 8px 4px; font-weight: 700; color: #ffffff; font-size: 11px; letter-spacing: 0.3px;
}
.tree-row td { padding: 4px 8px; color: rgba(255,255,255,0.45); }
.tree-row:hover { background: rgba(86,156,214,0.06); }
.tree-row--hl td { background: rgba(86,156,214,0.1); color: #569cd6; font-weight: 600; }
.indent-1 { padding-left: 18px !important; }
.indent-2 { padding-left: 30px !important; }
.col-urls { text-align: right; width: 40px; font-variant-numeric: tabular-nums; }
.col-pct { text-align: right; width: 58px; font-variant-numeric: tabular-nums; }
.chart-section { border-top: 1px solid rgba(255,255,255,0.06); padding: 12px; }
.chart-title { font-weight: 700; font-size: 8px; text-align: center; color: rgba(255,255,255,0.2); letter-spacing: 2px; margin-bottom: 8px; }
.chart-container { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.donut-chart { width: 120px; height: 120px; }
.chart-legend { display: flex; flex-wrap: wrap; gap: 4px 8px; justify-content: center; }
.legend-item { display: flex; align-items: center; gap: 4px; font-size: 10px; color: rgba(255,255,255,0.5); }
.legend-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }

/* ── Config tab ── */
.config-summary {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.config-section {
  display: flex;
  flex-direction: column;
}

.config-section-title {
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 1.5px;
  color: rgba(255,255,255,0.25);
  margin-bottom: 4px;
  padding: 4px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}

.config-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  font-size: 11px;
  align-items: baseline;
}

.config-label {
  color: rgba(255,255,255,0.45);
  flex-shrink: 0;
}

.config-value {
  color: #ffffff;
  font-weight: 600;
  text-align: right;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-transform: capitalize;
}

.config-value--off {
  color: rgba(255,255,255,0.3);
  font-weight: 400;
  text-transform: none;
}

.config-mono {
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  font-size: 10px;
  text-transform: none;
}

.config-actions {
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid rgba(255,255,255,0.06);
}

.btn-edit-settings {
  width: 100%;
  padding: 8px 16px;
  background: rgba(86,156,214,0.08);
  border: 1px solid rgba(86,156,214,0.3);
  border-radius: 20px;
  color: #569cd6;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
}

.btn-edit-settings:hover {
  background: rgba(86,156,214,0.15);
  border-color: #569cd6;
  box-shadow: 0 0 12px rgba(86,156,214,0.2);
}
</style>
