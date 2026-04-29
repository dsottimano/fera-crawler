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
  // Tier-3+ row: visible browser. Older sidecar builds don't emit this field.
  headed?: boolean;
  // Set on the wipe-and-retry row — destroys the persistent profile dir
  // before launching to clear poisoned anti-bot cookies. Optional so
  // older sidecar builds that don't emit it still render cleanly.
  wipeBaseProfile?: boolean;
}

interface ProbeRow {
  row: number;
  // Defensive demux key — the Rust lock prevents concurrent matrices,
  // but if it ever leaks we still want the modal to render only the
  // active probe's rows. Older sidecar builds don't emit this field.
  sampleUrl?: string;
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
const probeRowsExpected = ref(7);

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
// "Probe is finished" — true when probe-matrix-complete fires, regardless of
// row count. Probe matrix early-exits on first real 200, so row count alone
// no longer signals completion.
const probeFinished = ref(false);
const allFailed = computed(() => probeFinished.value && !firstSuccessRow.value);

function reasonSummary(reasons: Record<string, number>): string {
  return Object.entries(reasons)
    .map(([k, n]) => `${n}× ${reasonLabel[k] ?? k}`)
    .join(", ");
}

// Patchright/Chromium errors can be 500-char paragraphs ('Looks like
// Playwright was just installed... here are next steps...'). Show the
// first useful sentence inline; full text is in the row's title attr
// so hovering reveals it.
function shortenError(err: string): string {
  const trimmed = err.trim();
  // Strip the "launch: " / "probe: " prefix so the user sees the meat.
  const stripped = trimmed.replace(/^(launch|probe):\s*/, "");
  // First line, capped at 120 chars.
  const firstLine = stripped.split("\n")[0];
  return firstLine.length > 120 ? firstLine.slice(0, 117) + "…" : firstLine;
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

// Set when an auto-probe is running so probe-matrix-complete knows to
// auto-apply the winning config (instead of waiting for a user click).
const autoProbeMode = ref(false);
const autoProbedHosts = ref<Set<string>>(new Set());

// Pending hosts whose auto-probe was deferred because another probe was
// already running. Drained on probe-matrix-complete-with-no-winner. (A
// winning probe restarts the crawl, which makes the queue moot — those
// hosts will either get unblocked by the new settings or re-trigger a
// fresh block-detected.) Kept as an array, not a Set, because the
// arrival order is the order the user observed the blocks.
const pendingAutoProbeHosts = ref<BlockInfo[]>([]);

function drainPendingAutoProbe() {
  while (pendingAutoProbeHosts.value.length > 0) {
    const next = pendingAutoProbeHosts.value.shift()!;
    if (autoProbedHosts.value.has(next.host)) continue;
    void startAutoProbe(next);
    return;
  }
}

const explainerOpen = ref(false);
const probeApplyInFlight = ref(false);

async function openProbe(info: BlockInfo) {
  // Single-flight guard: the Rust side now rejects a second probe matrix
  // while one is in flight, but we surface the constraint earlier so the
  // user gets a useful message instead of a generic 'Probe failed to
  // start' alert. If they really want to switch hosts, they can wait
  // for the running probe to finish.
  if (probeRunning.value) {
    alert(
      `Another probe is already running for ${probeHost.value || "another host"}.\n\n` +
      "Wait for it to finish, then click PROBE again. Multiple probes can't run in parallel — " +
      "they'd fight over the shared browser profile and emit interleaved results.",
    );
    return;
  }
  probeHost.value = info.host;
  probeSampleUrl.value = info.sampleUrls[0] ?? `https://${info.host}/`;
  probeRows.value = [];
  probeFinished.value = false;
  probeRunning.value = true;
  probeOpen.value = true;
  try {
    await invoke("run_probe_matrix", { sampleUrl: probeSampleUrl.value });
  } catch (err) {
    console.error("run_probe_matrix failed", err);
    probeRunning.value = false;
    alert(`Probe failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Auto-probe path: runs the same probe machinery WITHOUT opening the modal.
// On probe-matrix-complete, applyRowAndResume is called automatically if a
// winning row exists.
async function startAutoProbe(info: BlockInfo) {
  if (autoProbedHosts.value.has(info.host)) return;  // already tried this host
  if (probeRunning.value) {
    // Another probe (manual or auto) is in flight. Queue this host so
    // it runs after — drainPendingAutoProbe picks it up on the next
    // probe-matrix-complete-with-no-winner. De-dup so a host that
    // re-blocks doesn't double-queue.
    if (!pendingAutoProbeHosts.value.some((p) => p.host === info.host)) {
      pendingAutoProbeHosts.value.push(info);
    }
    return;
  }
  autoProbedHosts.value.add(info.host);
  autoProbeMode.value = true;
  probeHost.value = info.host;
  probeSampleUrl.value = info.sampleUrls[0] ?? `https://${info.host}/`;
  probeRows.value = [];
  probeFinished.value = false;
  probeRunning.value = true;
  // Open the modal so the user sees the auto-probe in action — same UI
  // they'd get from clicking PROBE CONFIGS manually. Without this the
  // probe ran silently in the background, the user would click PROBE
  // CONFIGS thinking nothing was happening, get a "probe already
  // running" rejection, and have no idea why. applyRowAndResume calls
  // closeProbe() once a winning row applies, so the modal flow is:
  // open → rows tick → win → settings saved → modal auto-closes →
  // crawl resumes.
  probeOpen.value = true;
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
  probeFinished.value = false;
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
  if (!row) {
    alert("No winning row to apply.");
    return;
  }
  if (probeApplyInFlight.value) return;
  probeApplyInFlight.value = true;
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

    // Tier-3 (headed) rows mean "the wall only lets us through with a visible
    // browser". Honor that on the live crawl; otherwise leave headless as the
    // user had it, since headed mode is intrusive (visible window).
    if (cfg.headed) {
      await patch("authentication", "headless", false);
    }

    // The probe ran in a fresh isolated context — its "real 200" verdict is
    // only reproducible on the live crawl if the live profile is also clean.
    // Existing _abck / __cf_bm cookies poisoned by the prior block-tripping
    // run will keep blocking us with the new config otherwise.
    try { await invoke("wipe_browser_profile"); }
    catch (e) { console.error("wipe_browser_profile failed:", e); }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Failed to apply probe row settings:", e);
    probeApplyInFlight.value = false;
    // Apply failed: take the host OFF the once-per-crawl auto-probed
    // list so the user can manually re-probe (or so a future
    // block-detected event re-fires the auto-probe path). Without this,
    // a transient settings-save failure permanently strands the host
    // in the "already tried" set for the rest of the crawl.
    if (probeHost.value) {
      autoProbedHosts.value.delete(probeHost.value);
    }
    // Close the modal so the block-alert banner is visible again — the user
    // needs a path forward (re-probe, manual settings) without the modal
    // sitting in front. Without closeProbe(), they'd be stuck staring at a
    // dismissed alert with the modal still occupying the screen.
    closeProbe();
    alert(`Failed to save probe settings: ${msg}\n\nThe crawl was not resumed. The block banner is still visible — try Probe configs again, or adjust settings manually.`);
    return;
  }

  probeApplyInFlight.value = false;
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
      // Defensive: only render rows whose sampleUrl matches the active
      // probe. With the Rust lock there should never be a mismatch, but
      // a stray late-arriving result from a prior probe (e.g. user
      // closed the modal mid-probe and reopened for a different host)
      // would otherwise leak into the new modal's row list.
      const fromUrl = e.payload.sampleUrl;
      if (fromUrl && probeSampleUrl.value && fromUrl !== probeSampleUrl.value) return;
      probeRows.value.push(e.payload);
    }),
  );
  unlisteners.push(
    await listen("probe-matrix-complete", () => {
      probeRunning.value = false;
      probeFinished.value = true;
      // Manual + auto: apply the winning row automatically. The probe matrix
      // now early-exits on the first real 200, so this fires after the first
      // win without making the user wait through all rows + click. If the
      // applied config doesn't actually beat the wall on the live crawl, the
      // BlockAlert reappears and the user can re-probe.
      const winner = firstSuccessRow.value;
      const wasAuto = autoProbeMode.value;
      autoProbeMode.value = false;
      if (winner) {
        // applyRowAndResume restarts the whole crawl, so any queued
        // pending-host probes are moot — the new sidecar starts fresh
        // with the working config.
        pendingAutoProbeHosts.value = [];
        void applyRowAndResume(winner);
        return;
      }
      // No winner. If this was an auto-probe, drain the next queued host
      // (a different host that blocked while this probe was running).
      // Manual probes don't drain — the user owns the modal flow.
      if (wasAuto) {
        drainPendingAutoProbe();
      }
    }),
  );
  const clearBlocks = () => {
    blocks.value = new Map();
    // Reset auto-probe history so a new crawl gets fresh attempts.
    autoProbedHosts.value = new Set();
    pendingAutoProbeHosts.value = [];
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
          class="btn btn-primary"
          :title="'Test 6 stealth/rate configs against this host to find one that returns a real 200. Doesn\'t change anything until you click \'Save settings & resume\' on a winning row.'"
          @click="openProbe(info)"
        >Probe configs</button>
      </div>
    </div>
    <div class="block-alert-hint">
      <strong>Try host again</strong>: clear the gate, settings unchanged.
      &nbsp;·&nbsp;
      <strong>Probe configs</strong>: find a working stealth config without touching the running crawl.
    </div>
  </div>

  <!-- Probe matrix modal: teleported to <body> so position:fixed escapes any
       ancestor stacking context (otherwise the overlay can render behind the
       grid even with z-index: 1000). -->
  <Teleport to="body">
  <div v-if="probeOpen" class="probe-overlay" @click.self="closeProbe">
    <div class="probe-modal">
      <div class="probe-header">
        <span class="probe-title">Probe matrix — {{ probeHost }}</span>
        <button class="btn-close" @click="closeProbe">×</button>
      </div>
      <div class="probe-sample">
        Sample URL: <span class="mono">{{ probeSampleUrl }}</span>
      </div>
      <div class="probe-explainer">
        <button class="probe-explainer-toggle" type="button" @click="explainerOpen = !explainerOpen">
          {{ explainerOpen ? "▾" : "▸" }} What do these tiers and knobs mean?
        </button>
        <div v-if="explainerOpen" class="probe-explainer-body">
          <div class="probe-explainer-section">
            <strong>Stealth tier</strong> — which fingerprint patches are active.
            <ul>
              <li><code>off</code>: pure Patchright defaults. No init script, no UA override, no custom headers.</li>
              <li><code>tier-1</code>: full stealth stack <em>except</em> canvas noise and <code>userAgentData</code> UA-CH spoof. ~18 patches active (webdriver hide, plugins, languages, platform, hardware, permissions, chrome stub, screen metrics, WebGL, mediaDevices, etc.) plus fingerprint-derived UA + matching Sec-CH-UA headers.</li>
              <li><code>tier-2</code>: tier-1 plus canvas noise (RGB jitter on <code>toDataURL</code>/<code>getImageData</code>) and full UA-CH spoof. Maximum fingerprint coverage.</li>
            </ul>
          </div>
          <div class="probe-explainer-section">
            <strong>Other knobs</strong>
            <ul>
              <li><code>2s / 5s / 10s / 15s</code>: minimum gap between same-host requests. The single biggest lever on adaptive walls (Akamai, Cloudflare, DataDome) — they gate on RPS and release when pace drops. Matrix leads with delay escalation BEFORE fingerprint changes for this reason.</li>
              <li><code>warmup</code>: visit <code>origin/</code> once before the deep-link so Akamai's <code>_abck</code> / Cloudflare's <code>__cf_bm</code> challenge cookies set first.</li>
              <li><code>WIPE</code>: rm -rf the persistent browser profile dir before launching. Resets poisoned anti-bot cookies (Akamai's <code>~-1~</code>-stamped <code>_abck</code>; invalidated <code>__cf_bm</code>) that pre-judge every subsequent request. One of the strongest single moves; runs early so a typical re-block recovers in 2 attempts. Destructive — also clears any other site's login state in this profile.</li>
              <li><code>fresh</code>: throwaway browser-profile dir for this row, so prior poisoned cookies don't carry in (does NOT touch your persistent profile).</li>
              <li><code>residential-UA</code>: forces a Chrome-on-Windows UA string instead of the fingerprint-derived one.</li>
              <li><code>headed</code>: visible Chrome window. Catches walls that gate behavioral signals only in headless. Last-resort row.</li>
            </ul>
          </div>
          <div class="probe-explainer-section">
            <strong>Reading rows</strong> — each row gets more aggressive. The first <em>real 200</em> wins (cheapest config that beats the wall). If all rows fail, you're probably IP-banned: try a VPN or wait it out.
          </div>
        </div>
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
              <template v-if="probeRows[n - 1].config.wipeBaseProfile"> · <span class="c-cfg-wipe">WIPE</span></template>
              <template v-if="probeRows[n - 1].config.freshProfile"> · fresh</template>
              <template v-if="probeRows[n - 1].config.residentialUa"> · residential-UA</template>
              <template v-if="probeRows[n - 1].config.headed"> · headed</template>
            </div>
            <div class="c-status">{{ probeRows[n - 1].status || "—" }}</div>
            <div class="c-title mono">{{ probeRows[n - 1].title || "—" }}</div>
            <div class="c-result" :title="probeRows[n - 1].error ?? ''">
              <template v-if="!probeRows[n - 1].blocked">✓ real 200</template>
              <template v-else>
                ✗ {{ reasonLabel[probeRows[n - 1].reason ?? ""] ?? probeRows[n - 1].reason ?? "blocked" }}
                <span v-if="probeRows[n - 1].error" class="c-result-detail">— {{ shortenError(probeRows[n - 1].error!) }}</span>
              </template>
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

      <div v-if="probeFinished && firstSuccessRow" class="probe-outcome probe-outcome-ok">
        <div class="probe-outcome-title">Row #{{ firstSuccessRow.row }} returned a real 200 — this config gets through the wall.</div>
        <div class="probe-outcome-body">
          Winning config: stealth <strong>{{ firstSuccessRow.config.stealth }}</strong>,
          per-host delay <strong>{{ firstSuccessRow.config.rate }}</strong>
          <template v-if="firstSuccessRow.config.warmup">, <strong>session warmup on</strong></template>
          <template v-if="firstSuccessRow.config.wipeBaseProfile">, <strong>profile wiped</strong> (cleared poisoned anti-bot cookies)</template>
          <template v-if="firstSuccessRow.config.freshProfile">, <strong>fresh browser profile</strong> (throwaway dir, no persisted cookies)</template>
          <template v-if="firstSuccessRow.config.residentialUa">, <strong>residential user-agent</strong></template>
          <template v-if="firstSuccessRow.config.headed">, <strong>headed mode</strong> (visible browser window during crawl)</template>.
        </div>
        <div class="probe-outcome-howto">
          Auto-applying:
          <ol>
            <li>Saving these settings (stealth + per-host delay + warmup) to whatever's currently active — pinned snapshot if a saved crawl is loaded, otherwise the default profile.</li>
            <li>Wiping the browser profile (clears poisoned Akamai/Cloudflare cookies — the probe ran in a fresh context, so the live crawl needs to match).</li>
            <li>Stopping the running crawl and restarting with the new config — already-crawled URLs are skipped via excludeUrls.</li>
          </ol>
          <em>If the wall comes back, click <strong>Probe configs</strong> on the block banner to retry — the matrix will start over and pick a stronger row.</em>
        </div>
        <div class="probe-outcome-actions">
          <button
            v-if="!probeApplyInFlight"
            class="btn"
            :title="'Re-run the apply step (use this if auto-apply errored).'"
            @click="applyRowAndResume(firstSuccessRow)"
          >Retry apply</button>
          <span v-else class="probe-applying">
            <span class="spinner"></span> Applying…
          </span>
        </div>
      </div>

      <div v-else-if="allFailed" class="probe-outcome probe-outcome-fail">
        <div class="probe-outcome-title">All {{ probeRowsExpected }} configs were blocked.</div>
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
  </Teleport>
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

.probe-explainer {
  padding: 0 20px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
.probe-explainer-toggle {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.55);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  padding: 4px 0;
}
.probe-explainer-toggle:hover {
  color: #ffffff;
}
.probe-explainer-body {
  margin-top: 6px;
  padding: 10px 14px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.75);
  line-height: 1.5;
}
.probe-explainer-section {
  margin-bottom: 10px;
}
.probe-explainer-section:last-child {
  margin-bottom: 0;
}
.probe-explainer-section ul {
  margin: 4px 0 0;
  padding-left: 18px;
}
.probe-explainer-section li {
  margin: 2px 0;
}
.probe-explainer-section code {
  background: rgba(86, 156, 214, 0.1);
  color: #569cd6;
  padding: 1px 5px;
  border-radius: 3px;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  font-size: 10px;
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

/* WIPE badge in the config column — destructive op, deserves a callout
   so the user clocks it at a glance ("did the probe really nuke my
   profile? yes, deliberately, on row 2"). */
.c-cfg-wipe {
  font-weight: 700;
  color: #f4b266;
  letter-spacing: 0.5px;
}

/* Inline error excerpt next to the reason label — same row as
   "✗ launch error" but in muted color so the eye reads label first
   and detail second. Ellipsis on overflow; full text in title attr. */
.c-result-detail {
  color: rgba(255, 255, 255, 0.45);
  font-weight: 400;
  font-family: 'SF Mono', 'Cascadia Code', monospace;
  font-size: 10px;
}
.probe-trow .c-result {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.probe-applying {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: #569cd6;
  font-weight: 600;
  letter-spacing: 0.5px;
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
