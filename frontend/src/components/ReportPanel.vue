<script setup lang="ts">
import { computed, ref, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { CrawlResult } from "../types/crawl";

// Phase-6: reports fetch the full row set on open via query_all_results.
// Reports are an explicit user action ("show me the redirects"), so the
// one-shot full-table read is appropriate — the grid still pages.
const props = defineProps<{ report: string; sessionId: number | null }>();
const emit = defineEmits<{ close: [] }>();
const ready = ref(false);
const rows = ref<CrawlResult[]>([]);
const loading = ref(true);
onMounted(async () => {
  if (props.sessionId == null) { loading.value = false; setTimeout(() => { ready.value = true; }, 100); return; }
  try {
    rows.value = await invoke<CrawlResult[]>("query_all_results", { sessionId: props.sessionId });
  } catch (e) {
    console.error("query_all_results failed:", e);
  } finally {
    loading.value = false;
    setTimeout(() => { ready.value = true; }, 100);
  }
});

const title = computed(() => {
  const titles: Record<string, string> = { overview: "Crawl Overview", redirects: "Redirect Chains", duplicates: "Duplicate Content", orphans: "Orphan Pages", pagerank: "Internal PageRank" };
  return titles[props.report] ?? "Report";
});

const overviewStats = computed(() => {
  const r = rows.value;
  const total = r.length;
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let totalTime = 0, totalSize = 0, errors = 0;
  for (const row of r) {
    const sg = row.status ? `${Math.floor(row.status / 100)}xx` : "Error";
    byStatus[sg] = (byStatus[sg] || 0) + 1;
    const rt = row.resourceType || "Other";
    byType[rt] = (byType[rt] || 0) + 1;
    totalTime += row.responseTime || 0;
    totalSize += row.size || 0;
    if (row.error) errors++;
  }
  return { total, byStatus, byType, avgTime: total ? Math.round(totalTime / total) : 0, totalSize, errors };
});

const redirectResults = computed(() => rows.value.filter((r) => r.status >= 300 && r.status < 400));
const duplicateTitles = computed(() => {
  const m: Record<string, CrawlResult[]> = {};
  for (const r of rows.value) { if (!r.title) continue; if (!m[r.title]) m[r.title] = []; m[r.title].push(r); }
  return Object.entries(m).filter(([, u]) => u.length > 1);
});
const orphanPages = computed(() => rows.value.filter((r) => r.internalLinks === 0 && r.resourceType === "HTML"));

// Internal PageRank — runs over the existing outlinks data, no schema change.
// Universe = the set of crawled URLs in this session. Edges = each row's
// outlinks ∩ universe. Standard iterative PageRank, damping 0.85, until
// the max per-node delta drops below 1e-6 or 100 iterations elapse.
// Cost on 32k URLs × ~50 outlinks each: ~1-2s in pure JS, fine for a
// one-shot report. Cached by the computed dep on `rows`.
interface RankRow { url: string; score: number; indegree: number; outdegree: number; }
const pageRankResults = computed<RankRow[]>(() => {
  const rs = rows.value;
  if (!rs.length) return [];

  // Universe = crawled URLs, indexed for O(1) edge filter.
  const indexOf = new Map<string, number>();
  for (let i = 0; i < rs.length; i++) indexOf.set(rs[i].url, i);
  const N = rs.length;

  // Adjacency: for each node, its internal outlink indices (deduped).
  // Drop self-loops (url → url) — they don't carry SEO equity.
  const out: number[][] = new Array(N);
  const inDeg = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const ol = rs[i].outlinks ?? [];
    const seen = new Set<number>();
    for (const link of ol) {
      const j = indexOf.get(link);
      if (j === undefined || j === i) continue;
      if (seen.has(j)) continue;
      seen.add(j);
      inDeg[j]++;
    }
    out[i] = [...seen];
  }

  // Standard iterative PageRank.
  const d = 0.85;
  const base = (1 - d) / N;
  let pr = new Float64Array(N).fill(1 / N);
  let next = new Float64Array(N);

  for (let iter = 0; iter < 100; iter++) {
    next.fill(base);
    // Sink-page redistribution: pages with no outlinks distribute their
    // rank uniformly across the graph (otherwise rank "leaks" to dead-ends).
    let sinkRank = 0;
    for (let i = 0; i < N; i++) if (out[i].length === 0) sinkRank += pr[i];
    const sinkContribution = (d * sinkRank) / N;

    for (let i = 0; i < N; i++) {
      next[i] += sinkContribution;
      const links = out[i];
      if (links.length === 0) continue;
      const share = (d * pr[i]) / links.length;
      for (const j of links) next[j] += share;
    }

    let maxDelta = 0;
    for (let i = 0; i < N; i++) {
      const delta = Math.abs(next[i] - pr[i]);
      if (delta > maxDelta) maxDelta = delta;
    }
    [pr, next] = [next, pr];
    if (maxDelta < 1e-6) break;
  }

  const result: RankRow[] = new Array(N);
  for (let i = 0; i < N; i++) {
    result[i] = {
      url: rs[i].url,
      score: pr[i],
      indegree: inDeg[i],
      outdegree: out[i].length,
    };
  }
  result.sort((a, b) => b.score - a.score);
  return result;
});

const pageRankTop = computed(() => pageRankResults.value.slice(0, 100));
</script>

<template>
  <div class="overlay" @click.self="ready && emit('close')">
    <div class="modal report-modal">
      <div class="modal-header">
        <h3>{{ title }}</h3>
        <button class="close-btn" @click="emit('close')">&times;</button>
      </div>
      <div class="modal-body">
        <div v-if="loading" class="empty">Loading…</div>
        <div v-else-if="!rows.length" class="empty">No crawl data. Run a crawl first.</div>
        <template v-else-if="report === 'overview'">
          <div class="stat-grid">
            <div class="stat"><span class="stat-value">{{ overviewStats.total }}</span><span class="stat-label">TOTAL URLS</span></div>
            <div class="stat"><span class="stat-value">{{ overviewStats.avgTime }}<small>ms</small></span><span class="stat-label">AVG RESPONSE</span></div>
            <div class="stat"><span class="stat-value">{{ overviewStats.errors }}</span><span class="stat-label">ERRORS</span></div>
          </div>
          <h4>BY STATUS CODE</h4>
          <div class="breakdown">
            <div v-for="(count, group) in overviewStats.byStatus" :key="group" class="breakdown-row">
              <span class="breakdown-label" :class="'status-' + (group as string).charAt(0)">{{ group }}</span>
              <div class="bar-container"><div class="bar" :style="{ width: (count / overviewStats.total * 100) + '%' }"></div></div>
              <span class="breakdown-count">{{ count }}</span>
            </div>
          </div>
          <h4>BY RESOURCE TYPE</h4>
          <div class="breakdown">
            <div v-for="(count, type) in overviewStats.byType" :key="type" class="breakdown-row">
              <span class="breakdown-label">{{ type }}</span>
              <div class="bar-container"><div class="bar bar-type" :style="{ width: (count / overviewStats.total * 100) + '%' }"></div></div>
              <span class="breakdown-count">{{ count }}</span>
            </div>
          </div>
        </template>
        <template v-else-if="report === 'redirects'">
          <div v-if="!redirectResults.length" class="empty">No redirects found.</div>
          <table v-else class="report-table"><thead><tr><th>URL</th><th>Status</th></tr></thead><tbody><tr v-for="r in redirectResults" :key="r.url"><td class="url-cell">{{ r.url }}</td><td class="status-cell">{{ r.status }}</td></tr></tbody></table>
        </template>
        <template v-else-if="report === 'duplicates'">
          <div v-if="!duplicateTitles.length" class="empty">No duplicate titles found.</div>
          <div v-else v-for="[title, urls] in duplicateTitles" :key="title" class="dup-group"><h4 class="dup-title">{{ title }} ({{ urls.length }})</h4><ul><li v-for="u in urls" :key="u.url" class="dup-url">{{ u.url }}</li></ul></div>
        </template>
        <template v-else-if="report === 'orphans'">
          <div v-if="!orphanPages.length" class="empty">No orphan pages detected.</div>
          <table v-else class="report-table"><thead><tr><th>URL</th><th>Title</th></tr></thead><tbody><tr v-for="r in orphanPages" :key="r.url"><td class="url-cell">{{ r.url }}</td><td>{{ r.title }}</td></tr></tbody></table>
        </template>
        <template v-else-if="report === 'pagerank'">
          <div v-if="!pageRankTop.length" class="empty">Not enough data — need crawled URLs with internal outlinks.</div>
          <template v-else>
            <div class="pr-note">Internal PageRank computed over {{ pageRankResults.length }} URLs and their outlinks within this crawl. Damping 0.85, converged via iteration. Top 100 shown.</div>
            <table class="report-table">
              <thead>
                <tr>
                  <th style="width: 38px;">#</th>
                  <th>URL</th>
                  <th style="width: 80px; text-align: right;">Score</th>
                  <th style="width: 70px; text-align: right;">In</th>
                  <th style="width: 70px; text-align: right;">Out</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in pageRankTop" :key="r.url">
                  <td class="rank-cell">{{ i + 1 }}</td>
                  <td class="url-cell">{{ r.url }}</td>
                  <td class="num-cell">{{ r.score.toFixed(5) }}</td>
                  <td class="num-cell num-cell--in">{{ r.indegree }}</td>
                  <td class="num-cell num-cell--out">{{ r.outdegree }}</td>
                </tr>
              </tbody>
            </table>
          </template>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 200; backdrop-filter: blur(6px); }
.report-modal { background: #141a2e; border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; min-width: 600px; max-width: 800px; max-height: 80vh; color: rgba(255,255,255,0.7); display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; }
.modal-header h3 { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #ffffff; }
.close-btn { background: none; border: none; color: rgba(255,255,255,0.25); font-size: 18px; cursor: pointer; transition: color 0.15s; }
.close-btn:hover { color: #ffffff; }
.modal-body { padding: 20px; overflow-y: auto; flex: 1; }
.empty { color: rgba(255,255,255,0.25); text-align: center; padding: 24px; font-size: 11px; letter-spacing: 0.5px; }
.stat-grid { display: flex; gap: 12px; margin-bottom: 18px; }
.stat { flex: 1; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 14px; text-align: center; }
.stat-value { display: block; font-size: 16px; font-weight: 700; color: #569cd6; font-variant-numeric: tabular-nums; }
.stat-value small { font-size: 11px; color: rgba(255,255,255,0.25); }
.stat-label { font-size: 9px; color: rgba(255,255,255,0.25); letter-spacing: 1.5px; font-weight: 700; text-transform: uppercase; }
h4 { margin: 14px 0 8px; font-size: 9px; color: rgba(255,255,255,0.25); letter-spacing: 1.5px; font-weight: 700; text-transform: uppercase; }
.breakdown { display: flex; flex-direction: column; gap: 5px; }
.breakdown-row { display: flex; align-items: center; gap: 8px; font-size: 11px; }
.breakdown-label { min-width: 70px; font-weight: 600; }
.status-2 { color: #4ec9b0; } .status-3 { color: #dcdcaa; } .status-4 { color: #f44747; } .status-5 { color: #f44747; } .status-E { color: #f44747; }
.bar-container { flex: 1; height: 6px; background: rgba(255,255,255,0.04); border-radius: 3px; overflow: hidden; }
.bar { height: 100%; background: #569cd6; border-radius: 3px; min-width: 2px; }
.bar-type { background: rgba(86,156,214,0.6); }
.breakdown-count { min-width: 36px; text-align: right; color: rgba(255,255,255,0.25); font-variant-numeric: tabular-nums; }
.report-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.report-table th { text-align: left; padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.08); color: rgba(255,255,255,0.25); font-weight: 700; font-size: 8px; letter-spacing: 1.5px; text-transform: uppercase; }
.report-table td { padding: 4px 8px; border-bottom: 1px solid rgba(255,255,255,0.04); }
.url-cell { max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status-cell { text-align: center; }
.dup-group { margin-bottom: 12px; }
.dup-title { color: #dcdcaa !important; margin: 0 0 4px !important; font-size: 11px !important; letter-spacing: 0 !important; text-transform: none !important; }
.dup-url { font-size: 11px; color: rgba(255,255,255,0.25); padding: 1px 0; list-style: none; font-family: 'Ubuntu Mono', monospace; }
.dup-group ul { margin: 0; padding: 0 0 0 12px; }
.pr-note { font-size: 10px; color: rgba(255,255,255,0.45); margin-bottom: 12px; line-height: 1.5; }
.rank-cell { color: rgba(255,255,255,0.45); font-variant-numeric: tabular-nums; text-align: right; padding-right: 8px; }
.num-cell { font-variant-numeric: tabular-nums; text-align: right; font-family: 'Ubuntu Mono', monospace; }
.num-cell--in { color: #4ec9b0; }
.num-cell--out { color: rgba(255,255,255,0.4); }
</style>
