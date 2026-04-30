<script setup lang="ts">
// Network Live Map — visualizes per-request timing (DNS / TCP / TLS / TTFB
// / DOWNLOAD) as particles flowing through phase lanes. Real data wiring:
// the sidecar emits `{ type: "timing", ... }` per crawl-result, Rust
// forwards as the `sidecar-timing` Tauri event (gen-gated), this component
// listens. Ephemeral — never persisted to the DB.
//
// EXPERIMENTAL — temporary tab. If colleagues find it useful during real
// crawls, promote to a first-class view. Otherwise delete this file and
// remove the route entry in App.vue.
import { ref, reactive, onMounted, onUnmounted } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface TimingPayload {
  ts: number;
  url: string;
  host: string;
  status: number;
  dns: number; tcp: number; tls: number; ttfb: number; download: number;
  total: number;
  reused: boolean;
  bytes: number;
}

interface Particle {
  id: number;
  url: string; host: string; status: number; reused: boolean;
  phases: { id: PhaseId; ms: number; skip: boolean }[];
  total: number;
  laneIdx: number;     // index into phases (always advances)
  laneT: number;       // ms-into-current-lane
}

type PhaseId = "dns" | "tcp" | "tls" | "ttfb" | "download";

interface PhaseDef {
  id: PhaseId;
  label: string;
  colorVar: string;
  // Recent durations for avg/p95
  durations: number[];
  count: number;
}

// Phase definitions — ordered, time-flow left → right.
const PHASES = reactive<PhaseDef[]>([
  { id: "dns",      label: "DNS",           colorVar: "--phase-dns",  durations: [], count: 0 },
  { id: "tcp",      label: "TCP CONNECT",   colorVar: "--phase-tcp",  durations: [], count: 0 },
  { id: "tls",      label: "TLS HANDSHAKE", colorVar: "--phase-tls",  durations: [], count: 0 },
  { id: "ttfb",     label: "TTFB",          colorVar: "--phase-ttfb", durations: [], count: 0 },
  { id: "download", label: "DOWNLOAD",      colorVar: "--phase-dl",   durations: [], count: 0 },
]);

const particles = ref<Particle[]>([]);
const inFlight = ref(0);
const totalCount = ref(0);
const reusedCount = ref(0);
const totalTimes = ref<number[]>([]);
const completionsWindow = ref<number[]>([]);
const ppsLabel = ref("0.00");
const p50Label = ref("—");
const p95Label = ref("—");
const reuseLabel = ref("0%");

// Outlier list — slowest 12 recent requests, sorted-desc by total ms.
const outliers = ref<Particle[]>([]);

// Refs to lane bodies for positioning — populated by template ref binding.
const laneBodyRefs = ref<Record<PhaseId, HTMLElement | null>>({
  dns: null, tcp: null, tls: null, ttfb: null, download: null,
});
// Flash toggle per lane. Re-trigger by flipping false → true; CSS animation
// fires once on the class transition. Auto-resets via setTimeout so the
// next flash retriggers cleanly.
const laneFlashOn = reactive<Record<PhaseId, boolean>>({
  dns: false, tcp: false, tls: false, ttfb: false, download: false,
});
const laneFlashTimers: Partial<Record<PhaseId, ReturnType<typeof setTimeout>>> = {};
function triggerLaneFlash(id: PhaseId) {
  // Flip off→on. If it's already on (rapid second flash), force a brief
  // off-tick via a microtask so the class transition fires.
  if (laneFlashOn[id]) {
    laneFlashOn[id] = false;
    queueMicrotask(() => { laneFlashOn[id] = true; });
  } else {
    laneFlashOn[id] = true;
  }
  if (laneFlashTimers[id]) clearTimeout(laneFlashTimers[id]);
  laneFlashTimers[id] = setTimeout(() => { laneFlashOn[id] = false; }, 400);
}

// Tooltip state. Anchored to the in-flight dot under the cursor.
const tooltipOn = ref(false);
const tooltipX = ref(0);
const tooltipY = ref(0);
const tooltipParticle = ref<Particle | null>(null);

// Mock machine stats. Real wiring would poll `debug_snapshot` for sidecar/
// host RSS; we keep the visual but don't pretend it's live.
const machineStats = reactive([
  { id: "cpu",  label: "CPU",  unit: "%",  value: 42,  base: 42, jitter: 14, max: 100, format: (v: number) => Math.round(v) },
  { id: "ram",  label: "RAM",  unit: "GB", value: 8.4, base: 8.4, jitter: 0.6, max: 16,  format: (v: number) => v.toFixed(1) },
  { id: "temp", label: "TEMP", unit: "°C", value: 67,  base: 67, jitter: 4,  max: 95,  format: (v: number) => Math.round(v) },
]);

// ── Particle physics ────────────────────────────────────────────────────
function ingestTiming(t: TimingPayload) {
  const phases: Particle["phases"] = [
    { id: "dns",      ms: t.dns,      skip: t.reused || t.dns === 0 },
    { id: "tcp",      ms: t.tcp,      skip: t.reused || t.tcp === 0 },
    { id: "tls",      ms: t.tls,      skip: t.reused || t.tls === 0 },
    { id: "ttfb",     ms: t.ttfb,     skip: t.ttfb === 0 },
    { id: "download", ms: t.download, skip: t.download === 0 },
  ];
  // Sanity: at least one non-skip phase, otherwise drop.
  if (!phases.some((p) => !p.skip)) return;

  const p: Particle = {
    id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
    url: t.url, host: t.host, status: t.status, reused: t.reused,
    phases, total: t.total,
    laneIdx: -1, laneT: 0,
  };
  // Advance into first non-skipped phase
  advanceLane(p);
  particles.value.push(p);
}

function advanceLane(p: Particle) {
  let next = p.laneIdx + 1;
  while (next < p.phases.length && p.phases[next].skip) next++;

  // Record completed lane's duration
  if (p.laneIdx >= 0) {
    const finished = p.phases[p.laneIdx];
    if (!finished.skip) {
      const def = PHASES.find((x) => x.id === finished.id)!;
      def.durations.push(finished.ms);
      if (def.durations.length > 80) def.durations.shift();
      def.count++;
      triggerLaneFlash(def.id);
    }
  }

  if (next >= p.phases.length) {
    finishParticle(p);
    return;
  }
  p.laneIdx = next;
  p.laneT = 0;
}

function finishParticle(p: Particle) {
  // Remove from active list
  const idx = particles.value.indexOf(p);
  if (idx >= 0) particles.value.splice(idx, 1);

  totalCount.value++;
  if (p.reused) reusedCount.value++;
  totalTimes.value.push(p.total);
  if (totalTimes.value.length > 200) totalTimes.value.shift();
  completionsWindow.value.push(performance.now());

  // Insert into outliers (sorted-desc, capped 12)
  outliers.value.push(p);
  outliers.value.sort((a, b) => b.total - a.total);
  if (outliers.value.length > 12) outliers.value.length = 12;
}

let rafId = 0;
let lastT = 0;
let lastAvgUpdate = 0;
let lastMachineUpdate = 0;

function loop(t: number) {
  const dt = t - (lastT || t);
  lastT = t;

  // Advance particles.
  for (const p of particles.value) {
    p.laneT += dt;
    const cur = p.phases[p.laneIdx];
    if (cur && p.laneT >= cur.ms) {
      advanceLane(p);
    }
  }
  inFlight.value = particles.value.length;

  if (t - lastAvgUpdate > 400) {
    updateAggregates();
    lastAvgUpdate = t;
  }
  if (t - lastMachineUpdate > 600) {
    tickMachine();
    lastMachineUpdate = t;
  }

  rafId = requestAnimationFrame(loop);
}

function updateAggregates() {
  // Pages/sec
  const now = performance.now();
  while (completionsWindow.value.length && now - completionsWindow.value[0] > 10000) {
    completionsWindow.value.shift();
  }
  const elapsed = Math.max(now - (completionsWindow.value[0] ?? now), 1000);
  ppsLabel.value = (completionsWindow.value.length / (elapsed / 1000)).toFixed(2);

  // p50/p95 of total times
  if (totalTimes.value.length) {
    const sorted = [...totalTimes.value].sort((a, b) => a - b);
    p50Label.value = `${Math.round(sorted[Math.floor(sorted.length * 0.5)])} ms`;
    p95Label.value = `${Math.round(sorted[Math.floor(sorted.length * 0.95)])} ms`;
  }

  // Conn reuse rate
  if (totalCount.value > 0) {
    reuseLabel.value = `${Math.round((reusedCount.value / totalCount.value) * 100)}%`;
  }
}

function tickMachine() {
  for (const s of machineStats) {
    s.value += (Math.random() - 0.5) * (s.jitter * 0.4);
    s.value = Math.max(0, Math.min(s.max, s.value));
    s.value = s.value * 0.92 + s.base * 0.08;
  }
}

// ── Lane averages computed inline in the template ──────────────────────
function laneAvg(p: PhaseDef): string {
  if (!p.durations.length) return "—";
  const avg = p.durations.reduce((s, x) => s + x, 0) / p.durations.length;
  return `${Math.round(avg)}`;
}
function laneP95(p: PhaseDef): string {
  if (!p.durations.length) return "p95 — ms";
  const sorted = [...p.durations].sort((a, b) => a - b);
  const v = sorted[Math.floor(sorted.length * 0.95)];
  return `p95 ${Math.round(v)} ms`;
}

// Particles in a given lane — used by the template's v-for to render dots.
function particlesInLane(id: PhaseId): Particle[] {
  return particles.value.filter((p) => p.phases[p.laneIdx]?.id === id);
}

// Position a dot horizontally across its lane body. Vertical jitter is
// stable per-particle so two concurrent particles don't sit on top of each other.
function dotStyle(p: Particle, laneId: PhaseId) {
  const cur = p.phases[p.laneIdx];
  if (!cur || cur.id !== laneId) return { display: "none" };
  const ratio = Math.min(1, p.laneT / Math.max(cur.ms, 1));
  const jy = ((p.id * 53) % 100) / 100;
  return {
    left: `${ratio * 100}%`,
    top: `${10 + jy * 80}%`,
  };
}

function dominantPhase(p: Particle): { id: PhaseId; label: string; ms: number; colorVar: string } {
  const non = p.phases.filter((x) => !x.skip);
  const slowest = non.sort((a, b) => b.ms - a.ms)[0];
  const def = PHASES.find((x) => x.id === slowest.id)!;
  return { id: def.id, label: def.label, ms: slowest.ms, colorVar: def.colorVar };
}

// ── Tooltip handling ────────────────────────────────────────────────────
function showTooltip(e: MouseEvent, p: Particle) {
  tooltipParticle.value = p;
  tooltipX.value = e.clientX + 14;
  tooltipY.value = e.clientY + 14;
  tooltipOn.value = true;
}
function moveTooltip(e: MouseEvent) {
  tooltipX.value = e.clientX + 14;
  tooltipY.value = e.clientY + 14;
}
function hideTooltip() {
  tooltipOn.value = false;
}

// ── Lifecycle ──────────────────────────────────────────────────────────
let unlistenTiming: UnlistenFn | null = null;

onMounted(async () => {
  unlistenTiming = await listen<TimingPayload>("sidecar-timing", (e) => {
    ingestTiming(e.payload);
  });
  rafId = requestAnimationFrame(loop);
});

onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId);
  if (unlistenTiming) { try { unlistenTiming(); } catch {} }
  // Clear in-memory state so a remount starts fresh.
  particles.value = [];
  outliers.value = [];
});
</script>

<template>
  <div class="net-map">
    <header class="net-header">
      <div class="brand">FERA <em>—</em> NETWORK TIMING LIVE
        <span class="experimental">[experiment]</span></div>
      <div class="live-chip" :class="{ 'live-chip--idle': inFlight === 0 && totalCount === 0 }">
        <span class="live-dot"></span>
        {{ inFlight === 0 && totalCount === 0 ? 'WAITING' : 'LIVE' }}
      </div>
    </header>

    <div class="stage">
      <!-- Col 1: Fera + machine stats -->
      <div class="source-col">
        <div class="source-node">
          <div class="source-core"></div>
        </div>
        <div class="source-label">FERA</div>
        <div class="source-machine-stats">
          <div v-for="s in machineStats" :key="s.id" class="machine-stat-row">
            <div class="machine-stat">
              <span class="machine-stat-label">{{ s.label }}</span>
              <span class="machine-stat-value">{{ s.format(s.value) }} {{ s.unit }}</span>
            </div>
            <div class="machine-stat-bar">
              <div
                class="machine-stat-bar-fill"
                :style="{
                  width: Math.min(100, (s.value / s.max) * 100) + '%',
                  background: (s.value / s.max) < 0.5 ? 'var(--phase-ttfb)' :
                              (s.value / s.max) < 0.75 ? 'var(--phase-tls)' : 'var(--bad)'
                }"
              ></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Cols 2-6: phase lanes -->
      <div
        v-for="phase in PHASES"
        :key="phase.id"
        class="lane"
        :class="`lane--${phase.id}`"
        :style="{ '--lane-color': `var(${phase.colorVar})` }"
      >
        <div
          class="lane-flash"
          :style="{ background: `var(${phase.colorVar})` }"
          :class="{ 'lane-flash--on': laneFlashOn[phase.id] }"
        ></div>
        <div class="lane-header">
          <div class="lane-name">{{ phase.label }}</div>
          <div class="lane-avg">
            {{ laneAvg(phase) }}<span class="ms-unit"> ms</span>
          </div>
          <div class="lane-p95">{{ laneP95(phase) }}</div>
        </div>
        <div class="lane-body" :ref="(el) => (laneBodyRefs[phase.id] = el as HTMLElement)">
          <div
            v-for="p in particlesInLane(phase.id)"
            :key="p.id"
            class="particle"
            :style="{
              ...dotStyle(p, phase.id),
              background: `var(${phase.colorVar})`,
              color: `var(${phase.colorVar})`,
            }"
            @mouseenter="(e) => showTooltip(e, p)"
            @mousemove="moveTooltip"
            @mouseleave="hideTooltip"
          ></div>
        </div>
        <div class="lane-footer">
          <span>COMPLETED</span>
          <span class="lane-count" :style="{ color: `var(${phase.colorVar})` }">{{ phase.count.toLocaleString() }}</span>
        </div>
      </div>

      <!-- Col 7: outliers -->
      <div class="outliers-col">
        <div class="outliers-header">Slowest recent</div>
        <div class="outliers-list">
          <div v-if="outliers.length === 0" class="outliers-empty">
            No completed requests yet. Start a crawl.
          </div>
          <div
            v-for="p in outliers"
            :key="p.id"
            class="outlier"
          >
            <div class="outlier-url" :title="p.url">{{ p.url }}</div>
            <div class="outlier-bar">
              <div
                v-for="ph in p.phases.filter((x) => !x.skip && x.ms > 0)"
                :key="ph.id"
                class="outlier-seg"
                :style="{
                  width: ((ph.ms / p.total) * 100) + '%',
                  background: `var(${PHASES.find((x) => x.id === ph.id)!.colorVar})`,
                }"
              ></div>
            </div>
            <div class="outlier-meta">
              <span>{{ p.total }} ms{{ p.reused ? ' · reused' : '' }}</span>
              <span>
                <span :style="{ color: `var(${dominantPhase(p).colorVar})` }">{{ dominantPhase(p).label }}</span>
                {{ dominantPhase(p).ms }} ms
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Bottom strip -->
    <div class="stats-strip">
      <div class="stat">
        <span class="stat-label">PAGES</span>
        <span class="stat-value">{{ totalCount.toLocaleString() }}</span>
      </div>
      <div class="stat">
        <span class="stat-label">PAGES/SEC</span>
        <span class="stat-value" style="color: var(--phase-dns);">{{ ppsLabel }}</span>
      </div>
      <div class="stat">
        <span class="stat-label">IN FLIGHT</span>
        <span class="stat-value" style="color: var(--phase-tcp);">{{ inFlight }}</span>
      </div>
      <div class="stat">
        <span class="stat-label">P50 TOTAL</span>
        <span class="stat-value">{{ p50Label }}</span>
      </div>
      <div class="stat">
        <span class="stat-label">P95 TOTAL</span>
        <span class="stat-value" style="color: var(--phase-tls);">{{ p95Label }}</span>
      </div>
      <div class="stat">
        <span class="stat-label">CONN REUSE</span>
        <span class="stat-value" style="color: var(--phase-tcp);">{{ reuseLabel }}</span>
      </div>
    </div>

    <!-- Tooltip -->
    <div
      class="tooltip"
      :class="{ on: tooltipOn }"
      :style="{ left: tooltipX + 'px', top: tooltipY + 'px' }"
    >
      <template v-if="tooltipParticle">
        <div class="tooltip-url">{{ tooltipParticle.url }}</div>
        <div class="tt-phases">
          <template v-for="ph in tooltipParticle.phases" :key="ph.id">
            <span
              class="tt-phase-name"
              :style="{ color: ph.skip ? 'var(--text-muted)' : `var(${PHASES.find((x) => x.id === ph.id)!.colorVar})` }"
            >{{ PHASES.find((x) => x.id === ph.id)!.label }}</span>
            <span
              class="tt-phase-val"
              :style="ph.skip ? { color: 'var(--text-muted)' } : {}"
            >{{ ph.skip ? 'reused' : ph.ms + ' ms' }}</span>
          </template>
        </div>
        <div class="tt-total">
          <span class="tt-total-name">TOTAL</span>
          <span class="tt-total-val">{{ tooltipParticle.total }} ms</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.net-map {
  --phase-dns:  #569cd6;
  --phase-tcp:  #4ec9b0;
  --phase-tls:  #dcdcaa;
  --phase-ttfb: #c586c0;
  --phase-dl:   #d7ba7d;
  --bad: #f44747;
  --text-muted: rgba(255, 255, 255, 0.25);
  --text-dim: rgba(255, 255, 255, 0.45);

  position: relative;
  flex: 1;
  min-height: 0;
  display: flex; flex-direction: column;
  background: radial-gradient(ellipse at center, #0d1218 0%, #050608 70%);
  color: #e5e2e1;
  overflow: hidden;
}

.net-header {
  padding: 14px 24px;
  display: flex; align-items: center; justify-content: space-between;
  flex-shrink: 0;
}
.brand { font-size: 14px; font-weight: 700; letter-spacing: 1.5px; }
.brand em { color: var(--bad); font-style: normal; }
.experimental { color: var(--text-muted); margin-left: 8px; }

.live-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: 12px;
  background: rgba(78, 201, 176, 0.08);
  border: 1px solid rgba(78, 201, 176, 0.4);
  color: #4ec9b0;
  font-size: 9px; font-weight: 700; letter-spacing: 1.2px;
}
.live-chip--idle {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.12);
  color: var(--text-dim);
}
.live-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: pulse 1.5s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

/* ── Stage ── */
.stage {
  flex: 1; min-height: 0;
  margin: 0 24px;
  display: grid;
  grid-template-columns: 200px 1fr 1fr 1fr 2.5fr 1.6fr 240px;
  gap: 12px;
}

/* ── Source ── */
.source-col {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px;
}
.source-node {
  position: relative;
  width: 110px; height: 110px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(197,134,192,0.22) 0%, rgba(197,134,192,0) 70%);
  display: flex; align-items: center; justify-content: center;
}
.source-core {
  width: 14px; height: 14px; border-radius: 50%;
  background: var(--phase-ttfb);
  box-shadow: 0 0 16px var(--phase-ttfb), 0 0 32px var(--phase-ttfb);
  animation: pulse 2s infinite;
}
.source-label {
  font-size: 14px; font-weight: 700; letter-spacing: 2px; color: var(--phase-ttfb);
  text-transform: uppercase;
}
.source-machine-stats {
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px 14px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  width: 170px;
}
.machine-stat {
  display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
  font-family: 'SF Mono', 'Cascadia Code', monospace;
}
.machine-stat-label {
  font-size: 8px; font-weight: 700; letter-spacing: 1.2px;
  color: var(--text-muted); text-transform: uppercase;
}
.machine-stat-value {
  font-size: 11px; font-weight: 600; color: #fff;
  font-variant-numeric: tabular-nums;
}
.machine-stat-bar {
  margin-top: 3px; height: 2px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 1px; overflow: hidden;
}
.machine-stat-bar-fill {
  height: 100%; transition: width 0.3s ease;
}

/* ── Lane ── */
.lane {
  position: relative;
  background: rgba(255, 255, 255, 0.018);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.lane-header {
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255,255,255,0.05);
  display: flex; flex-direction: column; gap: 4px;
  flex-shrink: 0;
}
.lane-name {
  font-size: 9px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase;
  color: var(--lane-color);
}
.lane-avg {
  font-size: 18px; font-weight: 700; color: #fff;
  font-variant-numeric: tabular-nums;
  font-family: 'SF Mono', 'Cascadia Code', monospace;
  line-height: 1;
}
.ms-unit { font-size: 10px; color: var(--text-muted); margin-left: 2px; font-weight: 400; }
.lane-p95 {
  font-size: 9px; color: var(--text-muted); letter-spacing: 1px;
  text-transform: uppercase;
  font-family: 'SF Mono', 'Cascadia Code', monospace;
}
.lane-body {
  flex: 1; min-height: 0; position: relative;
}
.lane-footer {
  padding: 6px 14px;
  border-top: 1px solid rgba(255,255,255,0.05);
  display: flex; justify-content: space-between; align-items: center;
  font-size: 9px; letter-spacing: 1px; text-transform: uppercase;
  color: var(--text-muted);
  flex-shrink: 0;
}
.lane-count {
  font-weight: 700; font-family: 'SF Mono', 'Cascadia Code', monospace;
  font-variant-numeric: tabular-nums;
}
.lane-flash {
  position: absolute; inset: 0; pointer-events: none;
  opacity: 0;
  transition: opacity 0.4s;
}
.lane-flash--on {
  animation: laneFlash 0.4s;
}
@keyframes laneFlash {
  0% { opacity: 0.10; }
  100% { opacity: 0; }
}

/* ── Particle ── */
.particle {
  position: absolute;
  width: 8px; height: 8px;
  border-radius: 50%;
  box-shadow: 0 0 6px currentColor, 0 0 16px currentColor;
  transform: translate(-50%, -50%);
  pointer-events: auto;
  cursor: help;
  transition: left 0.1s linear, top 0.3s ease;
}

/* ── Outliers ── */
.outliers-col {
  display: flex; flex-direction: column;
  background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  overflow: hidden;
}
.outliers-header {
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255,255,255,0.05);
  font-size: 9px; font-weight: 700; letter-spacing: 1.2px;
  color: var(--text-dim); text-transform: uppercase;
}
.outliers-empty {
  padding: 16px; font-size: 10px;
  color: var(--text-muted);
  text-align: center;
}
.outliers-list {
  flex: 1; overflow-y: auto;
}
.outlier {
  padding: 8px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.03);
  font-family: 'SF Mono', 'Cascadia Code', monospace;
}
.outlier:last-child { border-bottom: none; }
.outlier-url {
  font-size: 9px; color: rgba(255,255,255,0.85);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.outlier-bar {
  margin-top: 4px;
  display: flex; height: 4px; border-radius: 2px; overflow: hidden;
  background: rgba(255,255,255,0.05);
}
.outlier-seg { height: 100%; }
.outlier-meta {
  margin-top: 3px;
  display: flex; justify-content: space-between;
  font-size: 8px; letter-spacing: 0.5px; color: var(--text-muted);
}

/* ── Tooltip ── */
.tooltip {
  position: fixed; z-index: 100;
  padding: 10px 12px; max-width: 380px;
  background: #141a2e;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  font-size: 11px; line-height: 1.45;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.1s;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
}
.tooltip.on { opacity: 1; }
.tooltip-url {
  font-family: 'SF Mono', 'Cascadia Code', monospace;
  color: #fff; word-break: break-all;
  margin-bottom: 6px;
}
.tt-phases {
  display: grid; grid-template-columns: 1fr auto;
  gap: 2px 14px;
  font-family: 'SF Mono', 'Cascadia Code', monospace;
  font-size: 10px;
}
.tt-phase-name { color: var(--text-dim); }
.tt-phase-val  { color: #fff; text-align: right; font-variant-numeric: tabular-nums; }
.tt-total {
  margin-top: 6px; padding-top: 6px;
  border-top: 1px solid rgba(255,255,255,0.08);
  display: flex; justify-content: space-between;
  font-family: 'SF Mono', 'Cascadia Code', monospace;
  font-size: 10px;
}
.tt-total-name { color: var(--text-dim); }
.tt-total-val { color: #fff; font-weight: 700; }

/* ── Stats strip ── */
.stats-strip {
  padding: 12px 24px;
  display: flex; gap: 28px; align-items: baseline;
  background: linear-gradient(0deg, rgba(0,0,0,0.7), rgba(0,0,0,0));
  flex-shrink: 0;
}
.stat { display: flex; flex-direction: column; gap: 2px; }
.stat-label { font-size: 8px; font-weight: 700; letter-spacing: 1.5px; color: var(--text-muted); text-transform: uppercase; }
.stat-value {
  font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums;
  font-family: 'SF Mono', 'Cascadia Code', monospace;
}
</style>
