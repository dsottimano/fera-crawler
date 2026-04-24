<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { useCrawlConfigs, domainOf, type ProbeResult, type QualityFlag } from "../../composables/useCrawlConfigs";

const { configs, probing, listConfigs, probeAndSave, deleteConfig } = useCrawlConfigs();

const newUrl = ref("");
const lastResult = ref<ProbeResult | null>(null);
const errorMsg = ref("");

onMounted(() => {
  listConfigs();
});

async function handleProbe() {
  errorMsg.value = "";
  lastResult.value = null;
  const url = newUrl.value.trim();
  if (!url) return;
  try {
    const result = await probeAndSave(url);
    lastResult.value = result;
    if (result.winningConfig) newUrl.value = "";
  } catch (e) {
    errorMsg.value = String(e);
  }
}

async function handleReProbe(domain: string) {
  errorMsg.value = "";
  lastResult.value = null;
  try {
    lastResult.value = await probeAndSave(`https://${domain}/`);
  } catch (e) {
    errorMsg.value = String(e);
  }
}

async function handleDelete(domain: string) {
  if (!confirm(`Delete saved config for ${domain}?`)) return;
  await deleteConfig(domain);
}

function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function summary(config: Record<string, unknown>): string {
  const parts: string[] = [];
  const stealth = (config.stealthConfig as { enabled?: boolean } | undefined)?.enabled;
  parts.push(`stealth ${stealth ? "ON" : "OFF"}`);
  parts.push(`${config.headless === false ? "headed" : "headless"}`);
  if (config.sessionWarmup) parts.push("warmup");
  if (typeof config.perHostDelay === "number" && config.perHostDelay !== 500) parts.push(`delay ${config.perHostDelay}ms`);
  if (typeof config.perHostConcurrency === "number" && config.perHostConcurrency !== 2) parts.push(`hostcc ${config.perHostConcurrency}`);
  return parts.join(" · ");
}

const FLAG_LABEL: Record<QualityFlag, string> = {
  "fake-200": "FAKE 200",
  "bot-verdict-visible": "BOT VERDICT",
  "thin-body-lt5kb": "BODY <5KB",
  "low-content-lt30w": "<30 WORDS",
  "no-seo-all3": "NO META/OG/CANONICAL",
  "cloaked-5pct": "CLOAKED (±5%)",
  "zero-outlinks": "0 OUTLINKS",
};

const sortedRanking = computed(() => {
  if (!lastResult.value) return [];
  return [...lastResult.value.ranking].sort((a, b) => {
    if (a.passesAllGates !== b.passesAllGates) return a.passesAllGates ? -1 : 1;
    const am = a.medianMs ?? Number.POSITIVE_INFINITY;
    const bm = b.medianMs ?? Number.POSITIVE_INFINITY;
    return am - bm;
  });
});
</script>

<template>
  <section class="section">
    <h2 class="section-label">PER-DOMAIN CRAWL CONFIGS</h2>
    <p class="hint">
      Tests all 5 rungs against your URL. For each passing rung, samples 5 more pages to
      measure real throughput. Winner = fastest rung that (1) returns 2xx, (2) delivers
      real content (not a fake-200 WAF page), and (3) isn't getting cloaked.
    </p>

    <div class="probe-row">
      <input
        v-model="newUrl"
        type="url"
        placeholder="https://example.com/"
        class="url-input"
        :disabled="!!probing"
        @keydown.enter.prevent="handleProbe"
      />
      <button
        class="btn-pill btn-probe"
        :disabled="!newUrl.trim() || !!probing"
        @click="handleProbe"
      >
        {{ probing ? `PROBING ${probing}…` : "PROBE" }}
      </button>
    </div>

    <div v-if="errorMsg" class="error">{{ errorMsg }}</div>

    <div v-if="lastResult" class="last-result">
      <div class="lr-header">
        <span class="lr-domain">{{ domainOf(lastResult.url) }}</span>
        <span v-if="lastResult.winningLabel" class="lr-win">
          WINNER → {{ lastResult.winningLabel }}
        </span>
        <span v-else class="lr-fail">NO CONFIG PASSED ALL GATES</span>
      </div>

      <div class="ranking-grid">
        <div class="ranking-head">
          <span>#</span>
          <span>RUNG</span>
          <span>STATUS</span>
          <span>QUAL</span>
          <span>FIRST</span>
          <span>MEDIAN</span>
          <span>GATES</span>
        </div>
        <div
          v-for="(rk, idx) in sortedRanking"
          :key="rk.label"
          class="ranking-row"
          :class="{
            'ranking-row--winner': rk.label === lastResult.winningLabel,
            'ranking-row--fail': !rk.passesAllGates,
          }"
        >
          <span class="rk-pos">{{ idx + 1 }}</span>
          <span class="rk-label">{{ rk.label }}</span>
          <span class="rk-status">
            {{ lastResult.attempts.find((a) => a.label === rk.label)?.status ?? "—" }}
          </span>
          <span class="rk-quality">{{ rk.qualityScore }}</span>
          <span class="rk-first">{{ rk.firstMs }}ms</span>
          <span class="rk-median">{{ rk.medianMs === null ? "—" : rk.medianMs + "ms" }}</span>
          <span class="rk-gates">{{ rk.passesAllGates ? "PASS" : "FAIL" }}</span>
        </div>
      </div>

      <details class="attempts-detail">
        <summary>Detailed attempts ({{ lastResult.attempts.length }})</summary>
        <ul class="attempts">
          <li
            v-for="a in lastResult.attempts"
            :key="a.step"
            class="attempt"
            :class="{
              'attempt--ok': a.passesAllGates,
              'attempt--blocked': a.blocked,
              'attempt--err': !a.ok && !a.blocked,
              'attempt--quality-fail': a.ok && !a.passesAllGates,
            }"
          >
            <div class="attempt-row">
              <span class="attempt-step">#{{ a.step + 1 }}</span>
              <span class="attempt-label">{{ a.label }}</span>
              <span class="attempt-status">{{ a.status ?? "ERR" }}</span>
              <span class="attempt-ms">{{ a.ms }}ms</span>
            </div>
            <div v-if="a.quality" class="attempt-quality">
              quality {{ a.quality.score }} · wc {{ a.quality.wordCount }} · bytes {{ a.quality.bodyBytes.toLocaleString() }} · outlinks {{ a.quality.outlinkCount }}
              <span
                v-for="flag in a.quality.flags"
                :key="flag"
                class="flag-chip"
              >{{ FLAG_LABEL[flag] }}</span>
            </div>
            <div v-if="a.speed" class="attempt-speed">
              samples [{{ a.speed.sampleMs.join(", ") || "—" }}]<span v-if="a.speed.failedSamples">
                · {{ a.speed.failedSamples }} failed</span> · median {{ a.speed.medianMs === null ? "—" : a.speed.medianMs + "ms" }}
            </div>
            <div v-if="a.error" class="attempt-error">{{ a.error }}</div>
          </li>
        </ul>
      </details>
    </div>

    <h3 class="subsection-label">SAVED CONFIGS ({{ configs.length }})</h3>
    <div v-if="!configs.length" class="empty">No probed domains yet.</div>
    <ul v-else class="config-list">
      <li v-for="c in configs" :key="c.domain" class="config-row">
        <div class="config-main">
          <div class="config-domain">{{ c.domain }}</div>
          <div class="config-summary">
            <span v-if="c.winningLabel" class="config-label">{{ c.winningLabel }}</span>
            <span v-else class="config-fail">no working config</span>
            <span class="config-detail">{{ summary(c.config) }}</span>
          </div>
          <div class="config-time">probed {{ fmtTime(c.probedAt) }}</div>
        </div>
        <div class="config-actions">
          <button
            class="btn-pill btn-reprobe"
            :disabled="!!probing"
            @click="handleReProbe(c.domain)"
          >
            RE-PROBE
          </button>
          <button class="btn-pill btn-del" @click="handleDelete(c.domain)">DELETE</button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-label,
.subsection-label {
  margin: 0;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.45);
}
.subsection-label { margin-top: 8px; }

.hint {
  margin: 0;
  font-size: 11px;
  font-weight: 400;
  color: rgba(255, 255, 255, 0.7);
  line-height: 1.5;
}

.probe-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.url-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
  color: #ffffff;
  font-size: 12px;
  font-weight: 600;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.url-input:focus {
  border-color: rgba(86, 156, 214, 0.5);
  box-shadow: 0 0 0 2px rgba(86, 156, 214, 0.1);
}
.url-input:disabled { opacity: 0.5; }

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
  text-transform: uppercase;
  white-space: nowrap;
}

.btn-probe { color: #4ec9b0; border-color: rgba(78, 201, 176, 0.3); }
.btn-probe:hover:not(:disabled) { background: rgba(78, 201, 176, 0.1); border-color: #4ec9b0; }
.btn-probe:disabled { opacity: 0.4; cursor: default; }

.btn-reprobe { color: #569cd6; border-color: rgba(86, 156, 214, 0.3); }
.btn-reprobe:hover:not(:disabled) { background: rgba(86, 156, 214, 0.1); border-color: #569cd6; }
.btn-reprobe:disabled { opacity: 0.4; cursor: default; }

.btn-del { color: rgba(244, 71, 71, 0.7); border-color: rgba(244, 71, 71, 0.2); }
.btn-del:hover { background: rgba(244, 71, 71, 0.08); color: #f44747; border-color: #f44747; }

.error {
  font-size: 11px;
  color: #f44747;
  padding: 8px 12px;
  border: 1px solid rgba(244, 71, 71, 0.3);
  border-radius: 6px;
  background: rgba(244, 71, 71, 0.06);
}

.last-result {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
}

.lr-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
}
.lr-domain { color: #ffffff; }
.lr-win { color: #4ec9b0; font-size: 10px; letter-spacing: 0.5px; font-weight: 700; }
.lr-fail { color: #f44747; font-size: 9px; font-weight: 700; letter-spacing: 1.2px; }

/* ranking grid */
.ranking-grid {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  overflow: hidden;
}
.ranking-head,
.ranking-row {
  display: grid;
  grid-template-columns: 24px minmax(180px, 1fr) 52px 48px 60px 68px 52px;
  gap: 8px;
  padding: 6px 10px;
  align-items: center;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
}
.ranking-head {
  background: rgba(255, 255, 255, 0.03);
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 1.5px;
  color: rgba(255, 255, 255, 0.45);
  text-transform: uppercase;
}
.ranking-row {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.7);
  font-variant-numeric: tabular-nums;
}
.ranking-row--winner {
  background: rgba(78, 201, 176, 0.08);
  color: #ffffff;
  font-weight: 600;
}
.ranking-row--winner .rk-label { color: #4ec9b0; }
.ranking-row--fail { color: rgba(255, 255, 255, 0.3); }
.ranking-row--fail .rk-gates { color: #f44747; }
.rk-pos { font-size: 9px; font-weight: 700; letter-spacing: 1.2px; }
.rk-status, .rk-quality, .rk-first, .rk-median, .rk-gates { text-align: right; }
.rk-gates { font-size: 9px; font-weight: 700; letter-spacing: 1.2px; }
.ranking-row--winner .rk-gates { color: #4ec9b0; }

.attempts-detail {
  margin-top: 4px;
}
.attempts-detail summary {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  color: rgba(255, 255, 255, 0.45);
  text-transform: uppercase;
  cursor: pointer;
  padding: 4px 0;
}
.attempts-detail summary:hover { color: rgba(255, 255, 255, 0.7); }

.attempts {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.attempt {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 10px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.04);
}
.attempt--ok { background: rgba(78, 201, 176, 0.06); border-color: rgba(78, 201, 176, 0.2); }
.attempt--blocked { background: rgba(244, 71, 71, 0.04); border-color: rgba(244, 71, 71, 0.15); }
.attempt--err { background: rgba(220, 220, 170, 0.04); border-color: rgba(220, 220, 170, 0.15); }
.attempt--quality-fail { background: rgba(220, 220, 170, 0.04); border-color: rgba(220, 220, 170, 0.25); }

.attempt-row {
  display: grid;
  grid-template-columns: 32px 1fr 56px 60px;
  gap: 8px;
  align-items: center;
  font-size: 11px;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
}
.attempt-step { color: rgba(255, 255, 255, 0.45); font-size: 9px; font-weight: 700; letter-spacing: 1.2px; }
.attempt-label { color: rgba(255, 255, 255, 0.85); }
.attempt-status { font-weight: 600; text-align: right; }
.attempt--ok .attempt-status { color: #4ec9b0; }
.attempt--blocked .attempt-status { color: #f44747; }
.attempt--err .attempt-status { color: #dcdcaa; }
.attempt--quality-fail .attempt-status { color: #dcdcaa; }
.attempt-ms { color: rgba(255, 255, 255, 0.45); font-variant-numeric: tabular-nums; text-align: right; font-size: 10px; }

.attempt-quality,
.attempt-speed {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.55);
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  padding-left: 40px;
  font-variant-numeric: tabular-nums;
}

.flag-chip {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(220, 220, 170, 0.15);
  color: #dcdcaa;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 1px;
}
.attempt--quality-fail .flag-chip,
.attempt--blocked .flag-chip {
  background: rgba(244, 71, 71, 0.15);
  color: #f44747;
}

.attempt-error {
  font-size: 10px;
  color: #dcdcaa;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  word-break: break-word;
  line-height: 1.4;
  padding-left: 40px;
}

.empty {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.25);
  padding: 8px 0;
}

.config-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }

.config-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
}

.config-main { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.config-domain { font-size: 12px; font-weight: 600; color: #ffffff; font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace; }
.config-summary { display: flex; gap: 8px; align-items: baseline; font-size: 10px; font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace; }
.config-label { color: #4ec9b0; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; font-size: 9px; }
.config-fail { color: #f44747; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; font-size: 9px; }
.config-detail { color: rgba(255, 255, 255, 0.45); }
.config-time { font-size: 9px; color: rgba(255, 255, 255, 0.25); letter-spacing: 0.5px; }
.config-actions { display: flex; gap: 6px; }
</style>
