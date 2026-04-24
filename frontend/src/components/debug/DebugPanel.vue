<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import { useDebug, type LogLevel } from "../../composables/useDebug";

const emit = defineEmits<{ close: [] }>();

const {
  logs,
  metrics,
  phases,
  latestMetric,
  currentPhase,
  snapshot,
  start,
  clearLogs,
  clearMetrics,
  refreshSnapshot,
  killSidecar,
} = useDebug();

type Tab = "logs" | "metrics" | "process";
const activeTab = ref<Tab>("logs");

const logLevelFilter = ref<Set<LogLevel>>(
  new Set(["debug", "info", "warn", "error", "stderr", "stdout"])
);
const logSearch = ref("");
const autoScroll = ref(true);

const filteredLogs = computed(() => {
  const q = logSearch.value.toLowerCase().trim();
  return logs.value.filter((l) => {
    if (!logLevelFilter.value.has(l.level)) return false;
    if (q && !l.msg.toLowerCase().includes(q)) return false;
    return true;
  });
});

function toggleLevel(level: LogLevel) {
  const next = new Set(logLevelFilter.value);
  if (next.has(level)) next.delete(level);
  else next.add(level);
  logLevelFilter.value = next;
}

const logScroll = ref<HTMLElement | null>(null);
function onLogScroll() {
  const el = logScroll.value;
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
  autoScroll.value = atBottom;
}

watch(filteredLogs, async () => {
  if (!autoScroll.value) return;
  await nextTick();
  const el = logScroll.value;
  if (el) el.scrollTop = el.scrollHeight;
});

function copyLogs() {
  const text = filteredLogs.value
    .map((l) => `${fmtTs(l.ts)} ${l.level.toUpperCase().padEnd(7)} ${l.msg}${l.meta ? " " + JSON.stringify(l.meta) : ""}`)
    .join("\n");
  void navigator.clipboard.writeText(text);
}

function fmtTs(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Sparkline: last 60 metric samples, pick a numeric field.
function sparklinePath(field: keyof import("../../composables/useDebug").MetricSample): string {
  const series = metrics.value.slice(-60).map((m) => Number(m[field]) || 0);
  if (series.length < 2) return "";
  const w = 120;
  const h = 28;
  const max = Math.max(...series, 1);
  const min = Math.min(...series, 0);
  const span = max - min || 1;
  return series
    .map((v, i) => {
      const x = (i / (series.length - 1)) * w;
      const y = h - ((v - min) / span) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

let snapTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  await start();
  await refreshSnapshot();
  snapTimer = setInterval(() => { void refreshSnapshot(); }, 2000);
  window.addEventListener("keydown", onKey);
});

onUnmounted(() => {
  if (snapTimer) clearInterval(snapTimer);
  window.removeEventListener("keydown", onKey);
});

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

async function handleKill() {
  if (!confirm("Kill sidecar process? The current crawl will terminate.")) return;
  await killSidecar();
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="panel" role="dialog" aria-label="Debug panel">
      <header class="panel-header">
        <div class="title-group">
          <div class="panel-title">DEBUG</div>
          <span class="phase-chip" :class="`phase-${currentPhase ?? 'idle'}`">
            <span class="phase-dot"></span>
            {{ (currentPhase ?? 'idle').toUpperCase() }}
          </span>
        </div>
        <div class="tab-group">
          <button
            v-for="t in (['logs', 'metrics', 'process'] as const)"
            :key="t"
            class="tab"
            :class="{ 'tab--active': activeTab === t }"
            @click="activeTab = t"
          >
            {{ t.toUpperCase() }}
          </button>
        </div>
        <button class="btn-close" @click="emit('close')" aria-label="Close">&#x2715;</button>
      </header>

      <!-- LOGS TAB -->
      <div v-if="activeTab === 'logs'" class="tab-body">
        <div class="logs-toolbar">
          <div class="level-filters">
            <button
              v-for="lvl in (['debug', 'info', 'warn', 'error', 'stderr', 'stdout'] as LogLevel[])"
              :key="lvl"
              class="level-chip"
              :class="[`level-${lvl}`, { 'level-chip--on': logLevelFilter.has(lvl) }]"
              @click="toggleLevel(lvl)"
            >
              {{ lvl }}
            </button>
          </div>
          <input
            v-model="logSearch"
            type="search"
            placeholder="Filter logs"
            class="log-search"
          />
          <div class="logs-actions">
            <span class="log-count">{{ filteredLogs.length }} / {{ logs.length }}</span>
            <button class="btn-mini" @click="copyLogs">COPY</button>
            <button class="btn-mini btn-mini--warn" @click="clearLogs">CLEAR</button>
          </div>
        </div>
        <div ref="logScroll" class="log-stream" @scroll="onLogScroll">
          <div v-if="!filteredLogs.length" class="empty">No log entries yet.</div>
          <div v-for="l in filteredLogs" :key="l.id" class="log-row" :class="`log-row--${l.level}`">
            <span class="log-ts">{{ fmtTs(l.ts) }}</span>
            <span class="log-level" :class="`level-${l.level}`">{{ l.level.toUpperCase() }}</span>
            <span class="log-msg">{{ l.msg }}</span>
            <span v-if="l.meta" class="log-meta">{{ JSON.stringify(l.meta) }}</span>
          </div>
        </div>
        <footer class="log-footer">
          <span v-if="!autoScroll" class="scroll-hint">auto-scroll paused — scroll to bottom to resume</span>
          <span v-else class="scroll-hint scroll-hint--on">auto-scroll on</span>
        </footer>
      </div>

      <!-- METRICS TAB -->
      <div v-if="activeTab === 'metrics'" class="tab-body">
        <div v-if="!latestMetric" class="empty">No metrics yet. Start a crawl.</div>
        <div v-else class="metric-grid">
          <div class="metric-card">
            <div class="metric-label">SIDECAR RSS</div>
            <div class="metric-value">{{ fmtBytes(latestMetric.rss) }}</div>
            <svg class="spark" viewBox="0 0 120 28" preserveAspectRatio="none">
              <path :d="sparklinePath('rss')" />
            </svg>
          </div>
          <div class="metric-card">
            <div class="metric-label">HEAP USED</div>
            <div class="metric-value">{{ fmtBytes(latestMetric.heapUsed) }}</div>
            <svg class="spark" viewBox="0 0 120 28" preserveAspectRatio="none">
              <path :d="sparklinePath('heapUsed')" />
            </svg>
          </div>
          <div class="metric-card">
            <div class="metric-label">HEAP TOTAL</div>
            <div class="metric-value">{{ fmtBytes(latestMetric.heapTotal) }}</div>
            <svg class="spark" viewBox="0 0 120 28" preserveAspectRatio="none">
              <path :d="sparklinePath('heapTotal')" />
            </svg>
          </div>
          <div class="metric-card">
            <div class="metric-label">PAGES/SEC</div>
            <div class="metric-value metric-value--num">{{ latestMetric.pagesPerSec.toFixed(2) }}</div>
            <svg class="spark" viewBox="0 0 120 28" preserveAspectRatio="none">
              <path :d="sparklinePath('pagesPerSec')" />
            </svg>
          </div>
          <div class="metric-card">
            <div class="metric-label">QUEUE</div>
            <div class="metric-value metric-value--num">{{ latestMetric.queueSize }}</div>
            <svg class="spark" viewBox="0 0 120 28" preserveAspectRatio="none">
              <path :d="sparklinePath('queueSize')" />
            </svg>
          </div>
          <div class="metric-card">
            <div class="metric-label">IN FLIGHT</div>
            <div class="metric-value metric-value--num">{{ latestMetric.inFlight }}</div>
            <svg class="spark" viewBox="0 0 120 28" preserveAspectRatio="none">
              <path :d="sparklinePath('inFlight')" />
            </svg>
          </div>
          <div class="metric-card">
            <div class="metric-label">PROCESSED</div>
            <div class="metric-value metric-value--num">{{ latestMetric.processed }}</div>
          </div>
          <div class="metric-card metric-card--err">
            <div class="metric-label">ERRORS</div>
            <div class="metric-value metric-value--num">{{ latestMetric.errors }}</div>
          </div>
        </div>

        <section class="phase-log">
          <h3 class="section-label">RECENT PHASES</h3>
          <ul v-if="phases.length" class="phase-list">
            <li v-for="(p, i) in phases.slice(-12).reverse()" :key="i">
              <span class="log-ts">{{ fmtTs(p.ts) }}</span>
              <span class="phase-name">{{ p.name }}</span>
              <span v-if="p.meta" class="log-meta">{{ JSON.stringify(p.meta) }}</span>
            </li>
          </ul>
          <div v-else class="empty">No phase transitions recorded.</div>
        </section>

        <footer class="metric-footer">
          <button class="btn-mini btn-mini--warn" @click="clearMetrics">CLEAR HISTORY</button>
          <span class="metric-hint">{{ metrics.length }} samples retained (last {{ Math.ceil(metrics.length) }}s)</span>
        </footer>
      </div>

      <!-- PROCESS TAB -->
      <div v-if="activeTab === 'process'" class="tab-body">
        <div v-if="!snapshot" class="empty">Loading…</div>
        <template v-else>
          <div class="proc-grid">
            <div class="proc-col">
              <h3 class="section-label">HOST (TAURI)</h3>
              <dl class="kv">
                <dt>PID</dt><dd>{{ snapshot.hostPid }}</dd>
                <dt>OS / ARCH</dt><dd>{{ snapshot.os }} / {{ snapshot.arch }}</dd>
                <dt>UPTIME</dt><dd>{{ fmtDuration(snapshot.uptimeSec) }}</dd>
                <template v-if="snapshot.hostProc">
                  <dt>RSS</dt><dd>{{ fmtBytes(snapshot.hostProc.rssBytes) }}</dd>
                  <dt>VM</dt><dd>{{ fmtBytes(snapshot.hostProc.vmBytes) }}</dd>
                  <dt>STATE</dt><dd>{{ snapshot.hostProc.state }}</dd>
                  <dt>THREADS</dt><dd>{{ snapshot.hostProc.threads }}</dd>
                </template>
              </dl>
            </div>

            <div class="proc-col">
              <h3 class="section-label">SIDECAR (NODE)</h3>
              <dl v-if="snapshot.sidecarPid" class="kv">
                <dt>PID</dt><dd>{{ snapshot.sidecarPid }}</dd>
                <dt>GENERATION</dt><dd>{{ snapshot.crawlGeneration }}</dd>
                <template v-if="snapshot.sidecarProc">
                  <dt>RSS</dt><dd>{{ fmtBytes(snapshot.sidecarProc.rssBytes) }}</dd>
                  <dt>VM</dt><dd>{{ fmtBytes(snapshot.sidecarProc.vmBytes) }}</dd>
                  <dt>STATE</dt><dd>{{ snapshot.sidecarProc.state }}</dd>
                  <dt>THREADS</dt><dd>{{ snapshot.sidecarProc.threads }}</dd>
                </template>
              </dl>
              <div v-else class="empty">Not running.</div>
              <button
                class="btn-pill btn-kill"
                :disabled="!snapshot.sidecarPid"
                @click="handleKill"
              >
                &#x25A0; KILL SIDECAR
              </button>
            </div>

            <div class="proc-col">
              <h3 class="section-label">CHROMIUM / CHILDREN</h3>
              <div v-if="!snapshot.sidecarChildren.length" class="empty">
                {{ snapshot.sidecarPid ? 'No children (headless browser may not have spawned yet).' : '—' }}
              </div>
              <ul v-else class="child-list">
                <li v-for="c in snapshot.sidecarChildren" :key="c.pid">
                  <span class="log-ts">pid {{ c.pid }}</span>
                  <span class="log-meta">{{ JSON.stringify(c.proc) }}</span>
                </li>
              </ul>
            </div>

            <div class="proc-col">
              <h3 class="section-label">STORAGE</h3>
              <dl class="kv">
                <dt>DATA DIR</dt><dd class="kv-path">{{ snapshot.dataDir ?? '—' }}</dd>
                <dt>DB PATH</dt><dd class="kv-path">{{ snapshot.dbPath ?? '—' }}</dd>
                <dt>DB SIZE</dt><dd>{{ fmtBytes(snapshot.dbSizeBytes) }}</dd>
              </dl>
            </div>
          </div>
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
  z-index: 400;
  backdrop-filter: blur(6px);
}

.panel {
  width: min(1100px, 94vw);
  height: min(720px, 90vh);
  background: #141a2e;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  color: #ffffff;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.title-group { display: flex; align-items: center; gap: 12px; }

.panel-title {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: #ffffff;
}

.phase-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 14px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.6);
}
.phase-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: rgba(255, 255, 255, 0.3);
}
.phase-startup .phase-dot, .phase-browser-launch .phase-dot { background: #dcdcaa; box-shadow: 0 0 6px rgba(220,220,170,0.6); }
.phase-sitemap-discovery .phase-dot { background: #c586c0; }
.phase-shutdown .phase-dot { background: #569cd6; }
.phase-idle .phase-dot { background: rgba(255, 255, 255, 0.2); }

.tab-group {
  display: flex;
  gap: 2px;
  margin-left: auto;
}
.tab {
  padding: 6px 16px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: transparent;
  color: rgba(255, 255, 255, 0.45);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  cursor: pointer;
  border-radius: 14px;
  transition: all 0.15s;
}
.tab:hover { color: rgba(255, 255, 255, 0.7); border-color: rgba(255, 255, 255, 0.2); }
.tab--active {
  color: #569cd6;
  border-color: rgba(86, 156, 214, 0.5);
  background: rgba(86, 156, 214, 0.1);
}

.btn-close {
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: transparent;
  color: rgba(255, 255, 255, 0.7);
  width: 24px; height: 24px;
  border-radius: 50%;
  cursor: pointer;
  font-size: 10px;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.btn-close:hover { color: #ffffff; border-color: rgba(255, 255, 255, 0.25); }

.tab-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 16px 20px;
}

/* ── LOGS ── */
.logs-toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  padding-bottom: 10px;
  flex-wrap: wrap;
}
.level-filters { display: flex; gap: 4px; }
.level-chip {
  padding: 3px 10px;
  border-radius: 14px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: transparent;
  color: rgba(255, 255, 255, 0.25);
  cursor: pointer;
  transition: all 0.15s;
}
.level-chip--on.level-debug { color: rgba(255,255,255,0.6); border-color: rgba(255,255,255,0.25); }
.level-chip--on.level-info { color: #569cd6; border-color: rgba(86,156,214,0.45); background: rgba(86,156,214,0.08); }
.level-chip--on.level-warn { color: #dcdcaa; border-color: rgba(220,220,170,0.45); background: rgba(220,220,170,0.08); }
.level-chip--on.level-error { color: #f44747; border-color: rgba(244,71,71,0.45); background: rgba(244,71,71,0.08); }
.level-chip--on.level-stderr { color: #f44747; border-color: rgba(244,71,71,0.35); background: rgba(244,71,71,0.05); }
.level-chip--on.level-stdout { color: #4ec9b0; border-color: rgba(78,201,176,0.35); background: rgba(78,201,176,0.05); }

.log-search {
  flex: 1 1 200px;
  padding: 6px 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
  color: #ffffff;
  font-size: 11px;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.log-search::placeholder { color: rgba(255,255,255,0.25); }
.log-search:focus {
  border-color: rgba(86,156,214,0.5);
  box-shadow: 0 0 0 2px rgba(86,156,214,0.1);
}

.logs-actions { display: flex; align-items: center; gap: 8px; }
.log-count {
  font-size: 9px;
  letter-spacing: 1px;
  color: rgba(255, 255, 255, 0.35);
  font-variant-numeric: tabular-nums;
}

.btn-mini {
  padding: 4px 10px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 14px;
  background: transparent;
  color: rgba(255, 255, 255, 0.6);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1px;
  cursor: pointer;
  transition: all 0.15s;
}
.btn-mini:hover { color: #ffffff; border-color: rgba(255, 255, 255, 0.3); }
.btn-mini--warn { color: #f44747; border-color: rgba(244, 71, 71, 0.3); }
.btn-mini--warn:hover { background: rgba(244, 71, 71, 0.1); border-color: #f44747; }

.log-stream {
  flex: 1;
  overflow-y: auto;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  background: #0c111d;
  padding: 8px 12px;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  font-size: 11px;
  line-height: 1.5;
}

.log-row {
  display: flex;
  gap: 8px;
  padding: 1px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.02);
  white-space: pre-wrap;
  word-break: break-all;
}
.log-ts { color: rgba(255, 255, 255, 0.25); flex-shrink: 0; }
.log-level {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 1px 6px;
  border-radius: 4px;
  align-self: center;
}
.log-level.level-debug { color: rgba(255,255,255,0.4); background: rgba(255,255,255,0.05); }
.log-level.level-info { color: #569cd6; background: rgba(86,156,214,0.1); }
.log-level.level-warn { color: #dcdcaa; background: rgba(220,220,170,0.1); }
.log-level.level-error { color: #f44747; background: rgba(244,71,71,0.12); }
.log-level.level-stderr { color: #f44747; background: rgba(244,71,71,0.08); }
.log-level.level-stdout { color: #4ec9b0; background: rgba(78,201,176,0.08); }
.log-msg { color: rgba(255,255,255,0.85); }
.log-meta { color: rgba(255,255,255,0.35); }

.log-row--error .log-msg, .log-row--stderr .log-msg { color: #f44747; }
.log-row--warn .log-msg { color: #dcdcaa; }

.log-footer { padding-top: 6px; }
.scroll-hint {
  font-size: 9px;
  color: rgba(255, 255, 255, 0.35);
  letter-spacing: 1px;
}
.scroll-hint--on { color: #4ec9b0; }

/* ── METRICS ── */
.metric-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 16px;
}
@media (max-width: 780px) {
  .metric-grid { grid-template-columns: repeat(2, 1fr); }
}

.metric-card {
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.02);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.metric-card--err { border-color: rgba(244, 71, 71, 0.15); }

.metric-label {
  font-size: 8px;
  font-weight: 600;
  letter-spacing: 1.5px;
  color: rgba(255, 255, 255, 0.25);
  text-transform: uppercase;
}
.metric-value {
  font-size: 16px;
  font-weight: 700;
  color: #ffffff;
  font-variant-numeric: tabular-nums;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
}
.metric-value--num { color: #569cd6; }
.metric-card--err .metric-value { color: #f44747; }

.spark {
  width: 100%;
  height: 28px;
  stroke: rgba(86, 156, 214, 0.8);
  stroke-width: 1;
  fill: none;
}
.metric-card--err .spark { stroke: rgba(244, 71, 71, 0.8); }

.phase-log {
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  padding-top: 12px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.phase-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  font-size: 11px;
}
.phase-list li { display: flex; gap: 8px; }
.phase-name { color: #c586c0; font-weight: 600; }

.metric-footer {
  padding-top: 8px;
  display: flex;
  align-items: center;
  gap: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}
.metric-hint {
  font-size: 9px;
  letter-spacing: 1px;
  color: rgba(255, 255, 255, 0.25);
}

/* ── PROCESS ── */
.proc-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 20px;
  overflow-y: auto;
}

.proc-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.02);
}

.section-label {
  margin: 0 0 8px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.45);
}

.kv {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 4px 12px;
  margin: 0;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  font-size: 11px;
}
.kv dt {
  font-size: 9px;
  letter-spacing: 1px;
  color: rgba(255, 255, 255, 0.35);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-weight: 600;
  align-self: center;
}
.kv dd {
  margin: 0;
  color: #ffffff;
  font-variant-numeric: tabular-nums;
  word-break: break-all;
}
.kv-path { font-size: 10px; color: rgba(255,255,255,0.6); }

.child-list {
  list-style: none;
  margin: 0;
  padding: 0;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  font-size: 10px;
  max-height: 140px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.child-list li { display: flex; gap: 8px; }

.empty {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.25);
  padding: 8px 0;
}

.btn-pill {
  padding: 6px 16px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 20px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  cursor: pointer;
  transition: all 0.2s;
  background: transparent;
  align-self: flex-start;
}
.btn-kill {
  color: #f44747;
  border-color: rgba(244, 71, 71, 0.3);
}
.btn-kill:hover:not(:disabled) {
  background: rgba(244, 71, 71, 0.1);
  border-color: #f44747;
  box-shadow: 0 0 16px rgba(244, 71, 71, 0.15);
}
.btn-kill:disabled { opacity: 0.25; cursor: default; }
</style>
