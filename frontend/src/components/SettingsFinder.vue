<script setup lang="ts">
import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CrawlResult } from "../types/crawl";

export interface TestResult {
  concurrency: number;
  delay: number;
  userAgent: string;
  respectRobots: boolean;
  avgResponseTime: number;
  maxResponseTime: number;
  minResponseTime: number;
  successRate: number;
  blocked: boolean;
  totalRequests: number;
  errors: number;
}

const BLOCKED_STATUSES = new Set([0, 403, 429, 503]);
const MAX_CONSECUTIVE_BLOCKS = 5;

const targetUrl = ref("");
const concurrencyValues = ref("1, 5, 10, 20");
const delayValues = ref("0, 100, 500, 1000");
const samplePages = ref(5);
const respectRobots = ref(true);
const userAgents = ref<string[]>(["default"]);
const customUa = ref("");

const running = ref(false);
const phase = ref<"config" | "discovering" | "testing" | "done" | "blocked">("config");
const testResults = ref<TestResult[]>([]);
const currentCombo = ref("");
const progress = ref({ current: 0, total: 0 });
const discoveredUrls = ref<string[]>([]);
const consecutiveBlocks = ref(0);
const signingIn = ref(false);

const UA_MAP: Record<string, string> = {
  default: "",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  bingbot: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
};

function parseValues(input: string): number[] {
  return input
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n >= 0);
}

const totalCombinations = computed(() => {
  const c = parseValues(concurrencyValues.value).length;
  const d = parseValues(delayValues.value).length;
  const u = userAgents.value.length;
  return c * d * u;
});

const recommended = computed(() => {
  const passing = testResults.value.filter((r) => r.successRate === 100 && !r.blocked);
  if (!passing.length) return null;
  passing.sort((a, b) => a.avgResponseTime - b.avgResponseTime);
  return passing[0];
});

function toggleUa(ua: string) {
  const idx = userAgents.value.indexOf(ua);
  if (idx >= 0) {
    if (userAgents.value.length > 1) userAgents.value.splice(idx, 1);
  } else {
    userAgents.value.push(ua);
  }
}

async function runTest() {
  if (!targetUrl.value.trim()) return;

  running.value = true;
  testResults.value = [];
  phase.value = "discovering";

  // Phase 1: Discovery — quick spider to find sample pages
  const pages = await discoverPages(targetUrl.value.trim(), samplePages.value);
  discoveredUrls.value = pages;

  if (pages.length === 0) {
    phase.value = "done";
    running.value = false;
    return;
  }

  // Phase 2: Grid search
  phase.value = "testing";
  const concurrencies = parseValues(concurrencyValues.value);
  const delays = parseValues(delayValues.value);
  const uas = userAgents.value;
  const combos: { concurrency: number; delay: number; ua: string }[] = [];

  for (const c of concurrencies) {
    for (const d of delays) {
      for (const ua of uas) {
        combos.push({ concurrency: c, delay: d, ua });
      }
    }
  }

  progress.value = { current: 0, total: combos.length };
  consecutiveBlocks.value = 0;

  for (const combo of combos) {
    if (!running.value) break;

    currentCombo.value = `Concurrency: ${combo.concurrency} | Delay: ${combo.delay}ms | UA: ${combo.ua}`;
    const result = await runSingleTest(pages, combo.concurrency, combo.delay, combo.ua);
    testResults.value.push(result);
    progress.value.current++;

    // Track consecutive blocks
    if (result.blocked || result.successRate === 0) {
      consecutiveBlocks.value++;
    } else {
      consecutiveBlocks.value = 0;
    }

    // Auto-stop after MAX_CONSECUTIVE_BLOCKS blocked results
    if (consecutiveBlocks.value >= MAX_CONSECUTIVE_BLOCKS) {
      running.value = false;
      phase.value = "blocked";
      currentCombo.value = "";
      return;
    }
  }

  phase.value = "done";
  running.value = false;
  currentCombo.value = "";
}

function stopTest() {
  running.value = false;
  invoke("stop_crawl").catch(() => {});
}

async function signInAndRetry() {
  signingIn.value = true;

  // Listen for browser close
  const unlisten = await listen<void>("browser-closed", () => {
    signingIn.value = false;
    unlisten();
  });

  try {
    await invoke("open_browser", { url: targetUrl.value.trim() });
  } catch (e) {
    console.error("Open browser failed:", e);
    signingIn.value = false;
    unlisten();
  }
}

async function retryAfterSignIn() {
  // Reset and re-run with same settings
  testResults.value = [];
  consecutiveBlocks.value = 0;
  phase.value = "config";
  // Auto-start
  await runTest();
}

function backToConfig() {
  phase.value = "config";
  testResults.value = [];
  consecutiveBlocks.value = 0;
}

async function discoverPages(url: string, max: number): Promise<string[]> {
  return new Promise(async (resolve) => {
    const results: string[] = [];
    const unlisten = await listen<CrawlResult>("crawl-result", (event) => {
      results.push(event.payload.url);
    });
    const unlistenDone = await listen<void>("crawl-complete", () => {
      unlisten();
      unlistenDone();
      resolve(results);
    });

    try {
      await invoke("start_crawl", {
        url,
        maxRequests: max,
        concurrency: 1,
        delay: 500,
        mode: "spider",
        respectRobots: respectRobots.value,
      });
    } catch (e) {
      unlisten();
      unlistenDone();
      resolve(results);
    }
  });
}

async function runSingleTest(
  urls: string[],
  concurrency: number,
  delay: number,
  uaKey: string
): Promise<TestResult> {
  const ua = uaKey === "custom" ? customUa.value : (UA_MAP[uaKey] || "");

  return new Promise(async (resolve) => {
    const timings: number[] = [];
    let errors = 0;
    let blocked = false;

    const unlisten = await listen<CrawlResult>("crawl-result", (event) => {
      const r = event.payload;
      if (r.responseTime > 0) timings.push(r.responseTime);
      if (BLOCKED_STATUSES.has(r.status)) blocked = true;
      if (r.status >= 400 || r.status === 0 || r.error) errors++;
    });

    const unlistenDone = await listen<void>("crawl-complete", () => {
      unlisten();
      unlistenDone();

      const avg = timings.length ? Math.round(timings.reduce((a, b) => a + b, 0) / timings.length) : 0;
      const max = timings.length ? Math.max(...timings) : 0;
      const min = timings.length ? Math.min(...timings) : 0;
      const total = urls.length;
      const successRate = total > 0 ? Math.round(((total - errors) / total) * 100) : 0;

      resolve({
        concurrency,
        delay,
        userAgent: uaKey,
        respectRobots: respectRobots.value,
        avgResponseTime: avg,
        maxResponseTime: max,
        minResponseTime: min,
        successRate,
        blocked,
        totalRequests: total,
        errors,
      });
    });

    try {
      await invoke("start_crawl", {
        url: urls[0],
        maxRequests: urls.length,
        concurrency,
        delay: delay > 0 ? delay : null,
        userAgent: ua || null,
        respectRobots: respectRobots.value,
        mode: "list",
        urls,
      });
    } catch (e) {
      unlisten();
      unlistenDone();
      resolve({
        concurrency,
        delay,
        userAgent: uaKey,
        respectRobots: respectRobots.value,
        avgResponseTime: 0,
        maxResponseTime: 0,
        minResponseTime: 0,
        successRate: 0,
        blocked: false,
        totalRequests: urls.length,
        errors: urls.length,
      });
    }
  });
}
</script>

<template>
  <div class="sf">
    <!-- Config Phase -->
    <div v-if="phase === 'config'" class="sf-config">
      <div class="sf-header">
        <h2>Optimal Crawl Settings Finder</h2>
        <p class="sf-desc">Tests different crawl configurations against a target site to find the fastest settings that won't trigger rate limiting.</p>
      </div>

      <div class="sf-form">
        <label class="sf-field">
          <span>TARGET URL</span>
          <input v-model="targetUrl" type="url" placeholder="https://example.com/" @keyup.enter="runTest" />
        </label>

        <label class="sf-field">
          <span>CONCURRENCY VALUES</span>
          <input v-model="concurrencyValues" type="text" placeholder="1, 5, 10, 20" />
        </label>

        <label class="sf-field">
          <span>DELAY VALUES (MS)</span>
          <input v-model="delayValues" type="text" placeholder="0, 100, 500, 1000" />
        </label>

        <label class="sf-field">
          <span>SAMPLE PAGES PER TEST</span>
          <input v-model.number="samplePages" type="number" min="1" max="50" />
        </label>

        <div class="sf-field">
          <span>USER-AGENTS</span>
          <div class="ua-chips">
            <button
              v-for="ua in ['default', 'googlebot', 'bingbot', 'custom']"
              :key="ua"
              class="ua-chip"
              :class="{ 'ua-chip--active': userAgents.includes(ua) }"
              @click="toggleUa(ua)"
            >{{ ua }}</button>
          </div>
          <input
            v-if="userAgents.includes('custom')"
            v-model="customUa"
            type="text"
            class="ua-custom"
            placeholder="Custom user-agent string..."
          />
        </div>

        <label class="sf-field sf-checkbox">
          <input v-model="respectRobots" type="checkbox" />
          <span>RESPECT ROBOTS.TXT</span>
        </label>

        <div class="sf-actions">
          <span class="sf-combo-count">{{ totalCombinations }} combinations</span>
          <button class="btn-pill btn-go" :disabled="!targetUrl.trim() || totalCombinations === 0" @click="runTest">
            &#x25B6; RUN TEST
          </button>
        </div>
      </div>
    </div>

    <!-- Running Phase -->
    <div v-if="phase === 'discovering' || phase === 'testing'" class="sf-running">
      <div class="sf-progress-header">
        <h2>{{ phase === 'discovering' ? 'Discovering Sample Pages...' : 'Testing Combinations...' }}</h2>
        <button class="btn-pill btn-stop" @click="stopTest">&#x25A0; STOP</button>
      </div>

      <div v-if="phase === 'discovering'" class="sf-discovering">
        <div class="sf-spinner"></div>
        <p>Crawling {{ targetUrl }} to find sample pages...</p>
        <p class="sf-found">{{ discoveredUrls.length }} pages found</p>
      </div>

      <div v-if="phase === 'testing'" class="sf-testing">
        <div class="sf-progress-bar-wrap">
          <div class="sf-progress-bar" :style="{ width: (progress.total ? (progress.current / progress.total * 100) : 0) + '%' }"></div>
        </div>
        <p class="sf-progress-text">{{ progress.current }} / {{ progress.total }} — {{ currentCombo }}</p>

        <!-- Live results table -->
        <div v-if="testResults.length" class="sf-results-table-wrap">
          <table class="sf-results-table">
            <thead>
              <tr>
                <th>Concurrency</th>
                <th>Delay</th>
                <th>User-Agent</th>
                <th>Avg Time</th>
                <th>Max Time</th>
                <th>Success</th>
                <th>Blocked</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in testResults" :key="i" :class="{ 'row-blocked': r.blocked, 'row-fail': r.successRate < 100 }">
                <td>{{ r.concurrency }}</td>
                <td>{{ r.delay }}ms</td>
                <td>{{ r.userAgent }}</td>
                <td>{{ r.avgResponseTime }}ms</td>
                <td>{{ r.maxResponseTime }}ms</td>
                <td :class="{ 'val-good': r.successRate === 100, 'val-bad': r.successRate < 100 }">{{ r.successRate }}%</td>
                <td :class="{ 'val-bad': r.blocked }">{{ r.blocked ? 'YES' : 'No' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Blocked Phase -->
    <div v-if="phase === 'blocked'" class="sf-blocked-phase">
      <div class="sf-blocked-card">
        <div class="sf-blocked-icon">&#x1F6AB;</div>
        <h2>Site is Blocking Requests</h2>
        <p class="sf-blocked-desc">
          {{ MAX_CONSECUTIVE_BLOCKS }} consecutive test combinations were blocked by
          <strong>{{ targetUrl }}</strong>. The site is likely detecting automated requests.
        </p>

        <div class="sf-blocked-actions">
          <div v-if="!signingIn" class="sf-blocked-step">
            <div class="sf-step-num">1</div>
            <div class="sf-step-content">
              <p>Sign in to the site with a real browser session. This authenticates you and sets cookies that will carry into the crawl.</p>
              <button class="btn-pill btn-signin" @click="signInAndRetry">&#x1F511; SIGN IN TO SITE</button>
            </div>
          </div>
          <div v-else class="sf-blocked-step">
            <div class="sf-step-num">1</div>
            <div class="sf-step-content">
              <div class="sf-signin-status">
                <div class="sf-spinner"></div>
                <span>Browser is open — sign in, then close the browser window</span>
              </div>
            </div>
          </div>

          <div class="sf-blocked-step">
            <div class="sf-step-num">2</div>
            <div class="sf-step-content">
              <p>After signing in, retry the test. Your session cookies will be used for all test combinations.</p>
              <button class="btn-pill btn-go" :disabled="signingIn" @click="retryAfterSignIn">&#x25B6; RETRY TEST</button>
            </div>
          </div>
        </div>

        <div class="sf-blocked-footer">
          <button class="btn-pill btn-reset" @click="backToConfig">BACK TO SETTINGS</button>
          <button class="btn-pill btn-reset" @click="phase = 'done'">VIEW PARTIAL RESULTS</button>
        </div>
      </div>
    </div>

    <!-- Done Phase -->
    <div v-if="phase === 'done'" class="sf-done">
      <div class="sf-done-header">
        <h2>Results</h2>
        <button class="btn-pill btn-reset" @click="phase = 'config'">NEW TEST</button>
      </div>

      <div v-if="recommended" class="sf-recommended">
        <div class="sf-rec-label">RECOMMENDED SETTINGS</div>
        <div class="sf-rec-values">
          <div class="sf-rec-item"><span class="sf-rec-key">Concurrency</span><span class="sf-rec-val">{{ recommended.concurrency }}</span></div>
          <div class="sf-rec-item"><span class="sf-rec-key">Delay</span><span class="sf-rec-val">{{ recommended.delay }}ms</span></div>
          <div class="sf-rec-item"><span class="sf-rec-key">User-Agent</span><span class="sf-rec-val">{{ recommended.userAgent }}</span></div>
          <div class="sf-rec-item"><span class="sf-rec-key">Avg Response</span><span class="sf-rec-val">{{ recommended.avgResponseTime }}ms</span></div>
        </div>
      </div>

      <div v-if="!testResults.length" class="sf-empty">No results — test was stopped before any combinations completed.</div>

      <div v-if="testResults.length" class="sf-results-table-wrap">
        <table class="sf-results-table">
          <thead>
            <tr>
              <th>Concurrency</th>
              <th>Delay</th>
              <th>User-Agent</th>
              <th>Robots</th>
              <th>Avg Time</th>
              <th>Min Time</th>
              <th>Max Time</th>
              <th>Success</th>
              <th>Blocked</th>
              <th>Errors</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(r, i) in testResults"
              :key="i"
              :class="{
                'row-recommended': recommended && r.concurrency === recommended.concurrency && r.delay === recommended.delay && r.userAgent === recommended.userAgent,
                'row-blocked': r.blocked,
                'row-fail': r.successRate < 100 && !r.blocked,
              }"
            >
              <td>{{ r.concurrency }}</td>
              <td>{{ r.delay }}ms</td>
              <td>{{ r.userAgent }}</td>
              <td>{{ r.respectRobots ? 'Yes' : 'No' }}</td>
              <td>{{ r.avgResponseTime }}ms</td>
              <td>{{ r.minResponseTime }}ms</td>
              <td>{{ r.maxResponseTime }}ms</td>
              <td :class="{ 'val-good': r.successRate === 100, 'val-bad': r.successRate < 100 }">{{ r.successRate }}%</td>
              <td :class="{ 'val-bad': r.blocked }">{{ r.blocked ? 'YES' : 'No' }}</td>
              <td>{{ r.errors }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sf {
  flex: 1;
  overflow-y: auto;
  padding: 40px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* ── Config Phase ── */
.sf-config { max-width: 520px; width: 100%; }
.sf-header { margin-bottom: 28px; }
.sf-header h2 {
  font-size: 14px;
  font-weight: 700;
  color: #ffffff;
  letter-spacing: 1px;
  text-transform: uppercase;
  margin: 0 0 8px;
}
.sf-desc {
  font-size: 11px;
  color: rgba(255,255,255,0.4);
  margin: 0;
  line-height: 1.5;
}

.sf-form { display: flex; flex-direction: column; gap: 16px; }

.sf-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sf-field > span {
  font-size: 9px;
  font-weight: 600;
  color: rgba(255,255,255,0.35);
  letter-spacing: 1px;
  text-transform: uppercase;
}
.sf-field input[type="text"],
.sf-field input[type="url"],
.sf-field input[type="number"] {
  padding: 8px 12px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  color: #ffffff;
  font-size: 11px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s;
}
.sf-field input:focus {
  border-color: rgba(86,156,214,0.5);
  box-shadow: 0 0 0 2px rgba(86,156,214,0.1);
}

.sf-checkbox {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.sf-checkbox input { width: 14px; height: 14px; accent-color: #569cd6; }

.ua-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.ua-chip {
  padding: 5px 14px;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 14px;
  background: transparent;
  color: rgba(255,255,255,0.4);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  cursor: pointer;
  transition: all 0.15s;
  text-transform: uppercase;
}
.ua-chip:hover { color: #ffffff; border-color: rgba(255,255,255,0.25); }
.ua-chip--active {
  color: #569cd6;
  border-color: rgba(86,156,214,0.4);
  background: rgba(86,156,214,0.08);
}
.ua-custom {
  margin-top: 6px;
  padding: 8px 12px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  color: #ffffff;
  font-size: 11px;
  outline: none;
}
.ua-custom:focus {
  border-color: rgba(86,156,214,0.5);
  box-shadow: 0 0 0 2px rgba(86,156,214,0.1);
}

.sf-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}
.sf-combo-count {
  font-size: 11px;
  color: rgba(255,255,255,0.3);
  font-variant-numeric: tabular-nums;
}

/* ── Running Phase ── */
.sf-running { max-width: 900px; width: 100%; }
.sf-progress-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}
.sf-progress-header h2 {
  font-size: 14px;
  font-weight: 700;
  color: #ffffff;
  letter-spacing: 1px;
  text-transform: uppercase;
  margin: 0;
}

.sf-discovering {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px;
  color: rgba(255,255,255,0.5);
  font-size: 11px;
}
.sf-found { color: #569cd6; font-weight: 600; font-size: 14px; }

.sf-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid rgba(255,255,255,0.1);
  border-top-color: #569cd6;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.sf-testing { display: flex; flex-direction: column; gap: 14px; }

.sf-progress-bar-wrap {
  height: 4px;
  background: rgba(255,255,255,0.06);
  border-radius: 2px;
  overflow: hidden;
}
.sf-progress-bar {
  height: 100%;
  background: #569cd6;
  transition: width 0.3s ease;
  border-radius: 2px;
}
.sf-progress-text {
  font-size: 10px;
  color: rgba(255,255,255,0.35);
  margin: 0;
  letter-spacing: 0.3px;
}

/* ── Blocked Phase ── */
.sf-blocked-phase { max-width: 560px; width: 100%; }
.sf-blocked-card {
  background: rgba(244,71,71,0.04);
  border: 1px solid rgba(244,71,71,0.15);
  border-radius: 12px;
  padding: 28px;
}
.sf-blocked-icon { font-size: 28px; margin-bottom: 12px; }
.sf-blocked-card h2 {
  font-size: 14px;
  font-weight: 700;
  color: #f44747;
  letter-spacing: 1px;
  text-transform: uppercase;
  margin: 0 0 10px;
}
.sf-blocked-desc {
  font-size: 11px;
  color: rgba(255,255,255,0.5);
  margin: 0 0 24px;
  line-height: 1.6;
}
.sf-blocked-desc strong { color: rgba(255,255,255,0.8); }

.sf-blocked-actions {
  display: flex;
  flex-direction: column;
  gap: 20px;
  margin-bottom: 24px;
}
.sf-blocked-step {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}
.sf-step-num {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  color: rgba(255,255,255,0.4);
  flex-shrink: 0;
}
.sf-step-content { flex: 1; }
.sf-step-content p {
  font-size: 11px;
  color: rgba(255,255,255,0.5);
  margin: 0 0 10px;
  line-height: 1.5;
}
.sf-signin-status {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: #569cd6;
  padding: 10px 0;
}

.sf-blocked-footer {
  display: flex;
  gap: 8px;
  border-top: 1px solid rgba(255,255,255,0.06);
  padding-top: 16px;
}

.btn-signin {
  color: #dcdcaa;
  border-color: rgba(220,220,170,0.3);
}
.btn-signin:hover {
  background: rgba(220,220,170,0.1);
  border-color: #dcdcaa;
}

/* ── Done Phase ── */
.sf-done { max-width: 900px; width: 100%; }
.sf-done-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}
.sf-done-header h2 {
  font-size: 14px;
  font-weight: 700;
  color: #ffffff;
  letter-spacing: 1px;
  text-transform: uppercase;
  margin: 0;
}

.sf-recommended {
  padding: 16px 20px;
  background: rgba(78,201,176,0.06);
  border: 1px solid rgba(78,201,176,0.2);
  border-radius: 12px;
  margin-bottom: 20px;
}
.sf-rec-label {
  font-size: 9px;
  font-weight: 700;
  color: #4ec9b0;
  letter-spacing: 1.2px;
  margin-bottom: 10px;
}
.sf-rec-values { display: flex; gap: 24px; flex-wrap: wrap; }
.sf-rec-item { display: flex; flex-direction: column; gap: 2px; }
.sf-rec-key { font-size: 8px; font-weight: 600; color: rgba(255,255,255,0.25); letter-spacing: 1px; text-transform: uppercase; }
.sf-rec-val { font-size: 16px; font-weight: 700; color: #ffffff; font-variant-numeric: tabular-nums; }

.sf-empty {
  text-align: center;
  padding: 40px;
  color: rgba(255,255,255,0.2);
  font-size: 11px;
}

/* ── Results Table ── */
.sf-results-table-wrap {
  overflow-x: auto;
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 8px;
}
.sf-results-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.sf-results-table th {
  padding: 8px 12px;
  text-align: left;
  font-size: 8px;
  font-weight: 600;
  color: rgba(255,255,255,0.25);
  letter-spacing: 1.5px;
  text-transform: uppercase;
  background: rgba(255,255,255,0.03);
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.sf-results-table td {
  padding: 6px 12px;
  color: rgba(255,255,255,0.7);
  border-bottom: 1px solid rgba(255,255,255,0.04);
  font-variant-numeric: tabular-nums;
}
.sf-results-table tr:hover td { background: rgba(86,156,214,0.06); }

.row-recommended td {
  background: rgba(78,201,176,0.08) !important;
  color: #ffffff;
}
.row-blocked td { color: rgba(244,71,71,0.7); }
.row-fail td { color: rgba(220,220,170,0.7); }

.val-good { color: #4ec9b0 !important; font-weight: 600; }
.val-bad { color: #f44747 !important; font-weight: 600; }

/* ── Shared pill buttons (match App.vue) ── */
.btn-pill {
  padding: 6px 16px;
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 20px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
  background: transparent;
}
.btn-go {
  color: #4ec9b0;
  border-color: rgba(78,201,176,0.3);
}
.btn-go:hover:not(:disabled) {
  background: rgba(78,201,176,0.1);
  border-color: #4ec9b0;
}
.btn-go:disabled { opacity: 0.25; cursor: default; }
.btn-stop {
  color: #f44747;
  border-color: rgba(244,71,71,0.3);
}
.btn-stop:hover {
  background: rgba(244,71,71,0.1);
  border-color: #f44747;
}
.btn-reset {
  color: rgba(255,255,255,0.4);
  border-color: rgba(255,255,255,0.1);
}
.btn-reset:hover { color: #fff; border-color: rgba(255,255,255,0.25); }
</style>
