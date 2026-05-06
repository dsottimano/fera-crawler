<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface PacingUpdate {
  ts: number;
  host: string;
  delayMs: number;
  multiplier: number;
  blockRate: number;
  classification: string;
  action: "step-up" | "step-down" | "hold";
}

interface ReprobeEvent {
  ts: number;
  host: string;
  reason: "403-burst" | "ceiling-saturated";
  sampleUrl: string;
}

interface HostRow {
  host: string;
  delayMs: number;
  blockRate: number;
  lastAction: string;
  lastActionTs: number;
}

type Bucket = "AGGRESSIVE" | "STEADY" | "CAUTIOUS" | "PROBING";

const hostMap = ref(new Map<string, HostRow>());
const reprobes = ref<ReprobeEvent[]>([]);
const unlisteners: UnlistenFn[] = [];

function bucketFor(delayMs: number): Bucket {
  if (delayMs < 1000) return "AGGRESSIVE";
  if (delayMs < 3000) return "STEADY";
  if (delayMs < 8000) return "CAUTIOUS";
  return "PROBING";
}

const rows = computed(() =>
  [...hostMap.value.values()]
    .map((r) => ({ ...r, bucket: bucketFor(r.delayMs) }))
    .sort((a, b) => a.host.localeCompare(b.host)),
);

onMounted(async () => {
  unlisteners.push(
    await listen<PacingUpdate>("pacing-update", (e) => {
      const next = new Map(hostMap.value);
      next.set(e.payload.host, {
        host: e.payload.host,
        delayMs: e.payload.delayMs,
        blockRate: e.payload.blockRate,
        lastAction: e.payload.action,
        lastActionTs: e.payload.ts,
      });
      hostMap.value = next;
    }),
  );
  unlisteners.push(
    await listen<ReprobeEvent>("re-probe-requested", (e) => {
      reprobes.value.unshift(e.payload);
      if (reprobes.value.length > 50) reprobes.value.pop();
    }),
  );
  unlisteners.push(
    await listen("crawl-cleared", () => {
      hostMap.value = new Map();
      reprobes.value = [];
    }),
  );
  unlisteners.push(
    await listen("crawl-started", () => {
      hostMap.value = new Map();
      reprobes.value = [];
    }),
  );
});

onUnmounted(() => {
  for (const u of unlisteners) u();
});

function actionLabel(a: string, ts: number): string {
  const ago = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return `${a} (${ago}s ago)`;
}

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}
</script>

<template>
  <div class="card card--ok card--wide">
    <div class="card-title">
      ADAPTIVE PACING
      <span
        class="info-tip"
        data-tip="Live per-host pacing state from the rate-limit controller. Bucket reflects the current inter-request delay; block rate is the rolling share of 4xx/5xx/blocked responses. Re-probe events fire when sustained 403 bursts or ceiling saturation force a stealth re-evaluation."
      >i</span>
    </div>

    <div v-if="rows.length === 0" class="pacing-empty">No pacing activity yet.</div>
    <table v-else class="pacing-table">
      <thead>
        <tr>
          <th>Host</th>
          <th>State</th>
          <th>Delay</th>
          <th>Block rate</th>
          <th>Last action</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.host">
          <td class="cell-host">{{ r.host }}</td>
          <td>
            <span class="bucket" :class="`bucket--${r.bucket.toLowerCase()}`">{{ r.bucket }}</span>
          </td>
          <td class="cell-num">{{ r.delayMs }}ms</td>
          <td class="cell-num">{{ Math.round(r.blockRate * 100) }}%</td>
          <td class="cell-action">{{ actionLabel(r.lastAction, r.lastActionTs) }}</td>
        </tr>
      </tbody>
    </table>

    <div class="reprobe-log">
      <div class="reprobe-title">RE-PROBE EVENTS</div>
      <ul v-if="reprobes.length > 0" class="reprobe-list">
        <li v-for="(r, i) in reprobes" :key="i" class="reprobe-item">
          <span class="reprobe-ts">{{ timeOf(r.ts) }}</span>
          <span class="reprobe-host">{{ r.host }}</span>
          <span class="reprobe-reason">{{ r.reason }}</span>
        </li>
      </ul>
      <div v-else class="pacing-empty">No re-probes triggered.</div>
    </div>
  </div>
</template>

<style scoped>
.card {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  border-left-width: 4px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.card--ok { border-left-color: #4ec9b0; }
.card--wide { grid-column: 1 / -1; }

.card-title {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  color: rgba(255, 255, 255, 0.45);
  text-transform: uppercase;
}

.pacing-empty {
  padding: 12px 8px;
  color: rgba(255, 255, 255, 0.25);
  font-size: 11px;
  text-align: center;
}

.pacing-table {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.pacing-table th {
  text-align: left;
  padding: 6px 8px;
  font-size: 8px;
  font-weight: 600;
  letter-spacing: 1.5px;
  color: rgba(255, 255, 255, 0.25);
  text-transform: uppercase;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.pacing-table td {
  padding: 6px 8px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.7);
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
.pacing-table tbody tr:hover td { background: rgba(86, 156, 214, 0.08); color: #ffffff; }

.cell-host {
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  color: #ffffff;
}
.cell-num {
  font-weight: 600;
  color: #ffffff;
}
.cell-action {
  color: rgba(255, 255, 255, 0.45);
}

.bucket {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 14px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  border: 1px solid;
}
.bucket--aggressive {
  color: #4ec9b0;
  background: rgba(78, 201, 176, 0.08);
  border-color: rgba(78, 201, 176, 0.3);
}
.bucket--steady {
  color: #569cd6;
  background: rgba(86, 156, 214, 0.08);
  border-color: rgba(86, 156, 214, 0.3);
}
.bucket--cautious {
  color: #dcdcaa;
  background: rgba(220, 220, 170, 0.08);
  border-color: rgba(220, 220, 170, 0.3);
}
.bucket--probing {
  color: #f44747;
  background: rgba(244, 71, 71, 0.08);
  border-color: rgba(244, 71, 71, 0.3);
}

.reprobe-log {
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.reprobe-title {
  font-size: 8px;
  font-weight: 600;
  letter-spacing: 1.5px;
  color: rgba(255, 255, 255, 0.25);
  text-transform: uppercase;
}
.reprobe-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 180px;
  overflow: auto;
}
.reprobe-item {
  display: flex;
  gap: 12px;
  padding: 4px 8px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.7);
  font-variant-numeric: tabular-nums;
  border-radius: 5px;
}
.reprobe-item:hover { background: rgba(86, 156, 214, 0.08); color: #ffffff; }
.reprobe-ts {
  color: rgba(255, 255, 255, 0.45);
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
}
.reprobe-host {
  flex: 1;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  color: #ffffff;
}
.reprobe-reason {
  color: #dcdcaa;
  font-weight: 600;
  font-size: 9px;
  letter-spacing: 1.2px;
  text-transform: uppercase;
}
</style>
