<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "../composables/useSettings";

const emit = defineEmits<{
  "apply-probe-and-resume": [];
}>();

// Residential-looking UA — must match RESIDENTIAL_UA in sidecar/src/probeMatrix.ts.
// Inlined rather than emitted in probe-result events to keep the IPC payload small.
const RESIDENTIAL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

interface BlockInfo {
  host: string;
  reasons: Record<string, number>;
  stats: { blocked: number; window: number };
  sampleUrls: string[];
}

interface ProbeConfig {
  stealth: string;
  rate: string;
  warmup: boolean;
  freshProfile: boolean;
  residentialUa: boolean;
}

interface ProbeRow {
  row: number;
  config: ProbeConfig;
  status: number;
  title: string;
  blocked: boolean;
  reason: string | null;
  error?: string;
  durationMs: number;
}

const blocks = ref<Map<string, BlockInfo>>(new Map());

const probeOpen = ref(false);
const probeHost = ref<string>("");
const probeSampleUrl = ref<string>("");
const probeRunning = ref(false);
const probeRows = ref<ProbeRow[]>([]);
const probeRowsExpected = ref(6);

const reasonLabel: Record<string, string> = {
  status_403: "403",
  status_429: "429",
  status_5xx: "5xx",
  soft_title_phrase: "soft: block phrase",
  soft_title_repeat: "soft: repeated title",
  launch_error: "launch error",
};

const blockList = computed(() => Array.from(blocks.value.values()));

const firstSuccessRow = computed(() => probeRows.value.find((r) => !r.blocked));
const allDone = computed(() => probeRows.value.length >= probeRowsExpected.value);
const allFailed = computed(() => allDone.value && !firstSuccessRow.value);

function reasonSummary(reasons: Record<string, number>): string {
  return Object.entries(reasons)
    .map(([k, n]) => `${n}× ${reasonLabel[k] ?? k}`)
    .join(", ");
}

async function tryHostAgain(host: string) {
  // Send stdin command to the live sidecar: clear the gate, re-queue parked
  // URLs. Settings are unchanged — if the wall is still up, the gate will
  // trip again within ~15 requests.
  try {
    await invoke("resume_host", { host });
    blocks.value.delete(host);
    blocks.value = new Map(blocks.value);
  } catch (err) {
    // "no active crawl" means the sidecar already exited. The user wants the
    // toolbar RESUME button instead — it'll fully restart with excludeUrls.
    console.error("resume_host failed", err);
    alert(
      "The crawl already ended, so the host can't be un-paused on the running sidecar.\n\n" +
      "Use the toolbar RESUME button to restart the crawl from where it stopped, " +
      "or click PROBE to find a working config first.",
    );
  }
}

async function abandonHost(host: string) {
  // Tell the live sidecar: drop every parked URL for this host and don't try
  // it again in this run. Other hosts (if any) keep crawling.
  try {
    await invoke("stop_host", { host });
    blocks.value.delete(host);
    blocks.value = new Map(blocks.value);
  } catch (err) {
    console.error("stop_host failed", err);
  }
}

// Set when an auto-probe is running so probe-matrix-complete knows to
// auto-apply the winning config (instead of waiting for a user click).
const autoProbeMode = ref(false);
const autoProbedHosts = ref<Set<string>>(new Set());

async function openProbe(info: BlockInfo) {
  probeHost.value = info.host;
  probeSampleUrl.value = info.sampleUrls[0] ?? `https://${info.host}/`;
  probeRows.value = [];
  probeRunning.value = true;
  probeOpen.value = true;
  try {
    await invoke("run_probe_matrix", { sampleUrl: probeSampleUrl.value });
  } catch (err) {
    console.error("run_probe_matrix failed", err);
    probeRunning.value = false;
  }
}

// Auto-probe path: runs the same probe machinery WITHOUT opening the modal.
// On probe-matrix-complete, applyRowAndResume is called automatically if a
// winning row exists.
async function startAutoProbe(info: BlockInfo) {
  if (probeRunning.value) return;  // user already probing — don't collide
  if (autoProbedHosts.value.has(info.host)) return;  // already tried this host
  autoProbedHosts.value.add(info.host);
  autoProbeMode.value = true;
  probeHost.value = info.host;
  probeSampleUrl.value = info.sampleUrls[0] ?? `https://${info.host}/`;
  probeRows.value = [];
  probeRunning.value = true;
  // Modal stays closed — this is silent recovery.
  try {
    await invoke("run_probe_matrix", { sampleUrl: probeSampleUrl.value });
  } catch (err) {
    console.error("auto-probe run_probe_matrix failed", err);
    probeRunning.value = false;
    autoProbeMode.value = false;
  }
}

function closeProbe() {
  probeOpen.value = false;
  probeRunning.value = false;
  probeRows.value = [];
  probeHost.value = "";
}

async function openInExternal(url: string) {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch (err) {
    console.error("openUrl failed", err);
  }
}

// Translate a winning probe row into your active profile's settings, then
// stop the sidecar and restart with resume:true (so already-crawled URLs
// are skipped via excludeUrls). The new sidecar boots with the working
// stealth/rate/UA config that the probe just verified.
async function applyRowAndResume(row: ProbeRow) {
  const { patch } = useSettings();
  const cfg = row.config;
  const tier = cfg.stealth;

  try {
    // Stealth tier mapping — must match patchesFor() in sidecar/src/probeMatrix.ts.
    if (tier === "off") {
      await patch("stealth", "enabled", false);
    } else {
      await patch("stealth", "enabled", true);
      // tier-1 disables the two heaviest patches; tier-2 leaves all defaults on.
      await patch("stealth", "canvasNoise", tier !== "tier-1");
      await patch("stealth", "userAgentData", tier !== "tier-1");
    }

    // Residential UA override — empty string means "let stealth derive a UA".
    await patch("stealth", "userAgent", cfg.residentialUa ? RESIDENTIAL_UA : "");

    // Rate is encoded as "1000ms" / "2000ms" — parse to integer ms.
    const rateMs = parseInt(String(cfg.rate).replace(/[^0-9]/g, ""), 10);
    if (!Number.isNaN(rateMs)) {
      await patch("performance", "perHostDelay", rateMs);
    }

    await patch("performance", "sessionWarmup", !!cfg.warmup);

    // Fresh profile means "wipe Akamai/CF cookies before resuming". Without
    // this, poisoned _abck / __cf_bm cookies will keep us blocked even with
    // perfect stealth.
    if (cfg.freshProfile) {
      try { await invoke("wipe_browser_profile"); }
      catch (e) { console.error("wipe_browser_profile failed:", e); }
    }
  } catch (e) {
    console.error("Failed to apply probe row settings:", e);
    return;
  }

  closeProbe();
  // App.vue handles the actual stop+restart since it owns the URL + handleStart.
  emit("apply-probe-and-resume");
}

let unlisteners: UnlistenFn[] = [];

onMounted(async () => {
  const { settings } = useSettings();
  unlisteners.push(
    await listen<BlockInfo & { type: string }>("block-detected", (e) => {
      const p = e.payload;
      const info: BlockInfo = {
        host: p.host,
        reasons: p.reasons,
        stats: p.stats,
        sampleUrls: p.sampleUrls,
      };
      blocks.value.set(p.host, info);
      blocks.value = new Map(blocks.value);

      // Auto-probe-and-apply on first trip per host (if enabled).
      if (settings.value.performance.autoProbeOnBlock) {
        void startAutoProbe(info);
      }
    }),
  );
  // Cooldown auto-clear from the sidecar — remove the banner row, the host
  // is back in business (parked URLs already requeued sidecar-side).
  unlisteners.push(
    await listen<{ host: string; requeued: number }>("block-cooldown-cleared", (e) => {
      blocks.value.delete(e.payload.host);
      blocks.value = new Map(blocks.value);
    }),
  );
  unlisteners.push(
    await listen<{ rows: number; sampleUrl: string }>("probe-matrix-start", (e) => {
      probeRowsExpected.value = e.payload.rows ?? 6;
    }),
  );
  unlisteners.push(
    await listen<ProbeRow>("probe-result", (e) => {
      probeRows.value.push(e.payload);
    }),
  );
  unlisteners.push(
    await listen("probe-matrix-complete", () => {
      probeRunning.value = false;
      // Auto-mode: if a winning row was found, apply it immediately.
      // Otherwise drop the auto-mode flag and leave the user to investigate
      // (the banner is still showing, they can manually click Probe configs
      // to see what failed and run the IP-ban diagnostic).
      if (autoProbeMode.value) {
        const winner = firstSuccessRow.value;
        autoProbeMode.value = false;
        if (winner) {
          void applyRowAndResume(winner);
        }
      }
    }),
  );
  const clearBlocks = () => {
    blocks.value = new Map();
    // Reset auto-probe history so a new crawl gets fresh attempts.
    autoProbedHosts.value = new Set();
  };
  // Clear only when a NEW crawl starts — keep the banner visible after a
  // crawl ends so the user can see why it stopped and decide what to do.
  unlisteners.push(await listen("crawl-started", clearBlocks));
});

onUnmounted(() => {
  for (const fn of unlisteners) fn();
  unlisteners = [];
});
</script>

<template>
  <div v-if="blockList.length > 0" class="block-alert-wrap">
    <div v-for="info in blockList" :key="info.host" class="block-alert-row">
      <div class="block-alert-dot"></div>
      <div class="block-alert-body">
        <div class="block-alert-title">
          <span class="host">{{ info.host }}</span>
          <span class="meta">paused — {{ info.stats.blocked }}/{{ info.stats.window }} recent requests blocked</span>
        </div>
        <div class="block-alert-reasons">{{ reasonSummary(info.reasons) }}</div>
      </div>
      <div class="block-alert-actions">
        <button
          class="btn"
          :title="'Clear the pause and re-queue parked URLs for this host. Settings are unchanged — if the wall is still up, the gate will trip again.'"
          @click="tryHostAgain(info.host)"
        >Try host again</button>
        <button
          class="btn"
          :title="'Drop all parked URLs for this host and skip them for the rest of this crawl. Other hosts keep crawling.'"
          @click="abandonHost(info.host)"
        >Abandon host</button>
        <button
          class="btn btn-primary"
          :title="'Test 6 stealth/rate configs against this host to find one that returns a real 200. Doesn\'t change anything until you click \'Save settings & resume\' on a winning row.'"
          @click="openProbe(info)"
        >Probe configs</button>
      </div>
    </div>
    <div class="block-alert-hint">
      <strong>Try host again</strong>: clear the gate, settings unchanged.
      &nbsp;·&nbsp;
      <strong>Abandon host</strong>: skip remaining URLs on this host.
      &nbsp;·&nbsp;
      <strong>Probe configs</strong>: find a working stealth config without touching the running crawl.
    </div>
  </div>

  <!-- Probe matrix modal -->
  <div v-if="probeOpen" class="probe-overlay" @click.self="closeProbe">
    <div class="probe-modal">
      <div class="probe-header">
        <span class="probe-title">Probe matrix — {{ probeHost }}</span>
        <button class="btn-close" @click="closeProbe">×</button>
      </div>
      <div class="probe-sample">
        Sample URL: <span class="mono">{{ probeSampleUrl }}</span>
      </div>
      <div class="probe-table">
        <div class="probe-thead">
          <div class="c-num">#</div>
          <div class="c-cfg">CONFIG</div>
          <div class="c-status">STATUS</div>
          <div class="c-title">TITLE</div>
          <div class="c-result">RESULT</div>
          <div class="c-dur">MS</div>
        </div>
        <div
          v-for="n in probeRowsExpected"
          :key="n"
          class="probe-trow"
          :class="{
            'row-success': probeRows[n - 1] && !probeRows[n - 1].blocked,
            'row-blocked': probeRows[n - 1] && probeRows[n - 1].blocked,
          }"
        >
          <div class="c-num">{{ n }}</div>
          <template v-if="probeRows[n - 1]">
            <div class="c-cfg">
              {{ probeRows[n - 1].config.stealth }} · {{ probeRows[n - 1].config.rate }}
              <template v-if="probeRows[n - 1].config.warmup"> · warmup</template>
              <template v-if="probeRows[n - 1].config.freshProfile"> · fresh</template>
              <template v-if="probeRows[n - 1].config.residentialUa"> · residential-UA</template>
            </div>
            <div class="c-status">{{ probeRows[n - 1].status || "—" }}</div>
            <div class="c-title mono">{{ probeRows[n - 1].title || "—" }}</div>
            <div class="c-result">
              <template v-if="!probeRows[n - 1].blocked">✓ real 200</template>
              <template v-else>✗ {{ reasonLabel[probeRows[n - 1].reason ?? ""] ?? probeRows[n - 1].reason ?? "blocked" }}</template>
            </div>
            <div class="c-dur">{{ probeRows[n - 1].durationMs }}</div>
          </template>
          <template v-else>
            <div class="c-cfg"><span v-if="probeRunning" class="spinner"></span><span v-else>—</span></div>
            <div class="c-status">—</div>
            <div class="c-title">—</div>
            <div class="c-result">—</div>
            <div class="c-dur">—</div>
          </template>
        </div>
      </div>

      <div v-if="allDone && firstSuccessRow" class="probe-outcome probe-outcome-ok">
        <div class="probe-outcome-title">Row #{{ firstSuccessRow.row }} returned a real 200 — this config gets through the wall.</div>
        <div class="probe-outcome-body">
          Winning config: stealth <strong>{{ firstSuccessRow.config.stealth }}</strong>,
          per-host delay <strong>{{ firstSuccessRow.config.rate }}</strong>
          <template v-if="firstSuccessRow.config.warmup">, <strong>session warmup on</strong></template>
          <template v-if="firstSuccessRow.config.freshProfile">, <strong>fresh browser profile</strong> (wipes existing cookies)</template>
          <template v-if="firstSuccessRow.config.residentialUa">, <strong>residential user-agent</strong></template>.
        </div>
        <div class="probe-outcome-howto">
          Clicking the button below will:
          <ol>
            <li>Save these settings to your active profile (replaces your current stealth + per-host delay + warmup values).</li>
            <li v-if="firstSuccessRow.config.freshProfile">Wipe the browser profile directory (kills any poisoned Akamai/CloudFlare cookies).</li>
            <li>Stop the running crawl.</li>
            <li>Restart the crawl with the new config — already-crawled URLs will be skipped (no re-fetching).</li>
          </ol>
        </div>
        <div class="probe-outcome-actions">
          <button
            class="btn btn-primary"
            :title="'Save the row\'s config to your profile, stop the sidecar, and restart with the new settings. Skips already-crawled URLs.'"
            @click="applyRowAndResume(firstSuccessRow)"
          >Save settings &amp; resume crawl (skips already-crawled URLs)</button>
        </div>
      </div>

      <div v-else-if="allFailed" class="probe-outcome probe-outcome-fail">
        <div class="probe-outcome-title">All 6 configs were blocked.</div>
        <div class="probe-outcome-body">
          This may be an IP-level ban. Open the sample URL in your regular browser.
          If it loads fine there but not here, it's a fingerprint issue — try again later
          or use a different network. If it's blocked there too, your IP is banned —
          use a VPN or wait 24h.
        </div>
        <div class="probe-outcome-actions">
          <button class="btn" @click="openInExternal(probeSampleUrl)">Open in browser</button>
          <button class="btn" @click="closeProbe">Close</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.block-alert-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 16px;
  background: #0c111d;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.block-alert-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: rgba(244, 71, 71, 0.08);
  border: 1px solid rgba(244, 71, 71, 0.3);
  border-radius: 12px;
}

.block-alert-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f44747;
  box-shadow: 0 0 8px rgba(244, 71, 71, 0.6);
  flex-shrink: 0;
}

.block-alert-body {
  flex: 1;
  min-width: 0;
}

.block-alert-title {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.block-alert-title .host {
  font-size: 12px;
  font-weight: 600;
  color: #ffffff;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
}

.block-alert-title .meta {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.7);
}

.block-alert-reasons {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.45);
  margin-top: 4px;
}

.block-alert-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.btn {
  padding: 6px 16px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 20px;
  color: #ffffff;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  cursor: pointer;
  transition: 0.15s ease;
  font-family: inherit;
}

.btn:hover {
  border-color: rgba(255, 255, 255, 0.25);
  background: rgba(86, 156, 214, 0.08);
}

.btn-primary {
  border-color: rgba(86, 156, 214, 0.5);
  color: #569cd6;
}

.btn-primary:hover {
  background: rgba(86, 156, 214, 0.15);
}

/* Probe modal */
.probe-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(6px);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.probe-modal {
  background: #141a2e;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  width: min(900px, 92vw);
  max-height: 80vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
}

.probe-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.probe-title {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 1px;
  color: #ffffff;
}

.btn-close {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.45);
  font-size: 20px;
  cursor: pointer;
  line-height: 1;
  padding: 0 4px;
}

.btn-close:hover {
  color: #ffffff;
}

.probe-sample {
  padding: 12px 20px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.7);
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.mono {
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  color: #ffffff;
}

.probe-table {
  padding: 0 20px;
  font-size: 11px;
}

.probe-thead,
.probe-trow {
  display: grid;
  grid-template-columns: 32px 1.5fr 60px 1.5fr 1.2fr 60px;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.probe-thead {
  font-size: 8px;
  font-weight: 600;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.25);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.probe-trow {
  color: rgba(255, 255, 255, 0.7);
  font-variant-numeric: tabular-nums;
}

.probe-trow.row-success {
  background: rgba(78, 201, 176, 0.08);
}

.probe-trow.row-success .c-result {
  color: #4ec9b0;
}

.probe-trow.row-blocked .c-result {
  color: #f44747;
}

.c-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 1.5px solid rgba(86, 156, 214, 0.3);
  border-top-color: #569cd6;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.probe-outcome {
  margin: 16px 20px 20px;
  padding: 12px 16px;
  border-radius: 8px;
  border: 1px solid;
}

.probe-outcome-ok {
  background: rgba(78, 201, 176, 0.08);
  border-color: rgba(78, 201, 176, 0.3);
}

.probe-outcome-fail {
  background: rgba(244, 71, 71, 0.08);
  border-color: rgba(244, 71, 71, 0.3);
}

.probe-outcome-title {
  font-size: 12px;
  font-weight: 600;
  color: #ffffff;
  margin-bottom: 4px;
}

.probe-outcome-body {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.7);
  line-height: 1.5;
}

.probe-outcome-howto {
  margin-top: 8px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 8px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
  line-height: 1.5;
}

.probe-outcome-howto ol {
  margin: 4px 0 0 16px;
  padding: 0;
}

.probe-outcome-howto li {
  margin: 0;
}

.block-alert-hint {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.45);
  padding: 4px 12px 0 32px;
  line-height: 1.5;
}

.block-alert-hint strong {
  color: rgba(255, 255, 255, 0.7);
}

.probe-outcome-actions {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}
</style>
