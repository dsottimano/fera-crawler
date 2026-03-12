<script setup lang="ts">
import { computed } from "vue";
import type { CrawlResult } from "../types/crawl";

const props = defineProps<{ results: CrawlResult[] }>();
const internalTypes = ["HTML", "JavaScript", "CSS", "Images", "Media", "Fonts", "XML", "PDF", "Other", "Unknown"] as const;
const externalTypes = ["HTML", "JavaScript", "CSS", "Images"] as const;

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
</script>

<template>
  <div class="right-sidebar">
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
.resource-tree { flex: 1; overflow-y: auto; }
.tree-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.tree-table th {
  text-align: right; padding: 5px 8px; font-weight: 700; color: rgba(255,255,255,0.2);
  border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 8px; letter-spacing: 1.2px;
}
.tree-table th:first-child { text-align: left; }
.section-header td {
  padding: 8px 8px 3px; font-weight: 700; color: #ffffff; font-size: 11px; letter-spacing: 0.3px;
}
.tree-row td { padding: 2px 8px; color: rgba(255,255,255,0.45); }
.tree-row:hover { background: rgba(86,156,214,0.06); }
.tree-row--hl td { background: rgba(86,156,214,0.1); color: #569cd6; font-weight: 600; }
.indent-1 { padding-left: 18px !important; }
.indent-2 { padding-left: 30px !important; }
.col-urls { text-align: right; width: 40px; font-variant-numeric: tabular-nums; }
.col-pct { text-align: right; width: 58px; font-variant-numeric: tabular-nums; }
.chart-section { border-top: 1px solid rgba(255,255,255,0.06); padding: 12px; }
.chart-title { font-weight: 700; font-size: 8px; text-align: center; color: rgba(255,255,255,0.2); letter-spacing: 2px; margin-bottom: 6px; }
.chart-container { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.donut-chart { width: 120px; height: 120px; }
.chart-legend { display: flex; flex-wrap: wrap; gap: 3px 10px; justify-content: center; }
.legend-item { display: flex; align-items: center; gap: 4px; font-size: 10px; color: rgba(255,255,255,0.5); }
.legend-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
</style>
