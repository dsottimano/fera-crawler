<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useCrawl } from "../composables/useCrawl";

// Phase 5: top-level Health view. Cards summarize the crawl in
// SQL-aggregate terms (per the plan: "every card is one SQL aggregate
// query"). Three data sources stack:
//   1) HealthSnapshot from `aggregate_health` — totals, status mix,
//      indexability, response-time aggregates. Refreshed on session
//      change, on rowCount tick (during crawl), and on demand.
//   2) crawlProgress from useCrawl — rolling rowCount/lastUrl/error
//      count for the hero status card. Lower latency than the SQL
//      aggregate while a crawl is running.
//   3) Drill-through events: each card emits the (tab, filterType)
//      pair that lands the user on the matching DATA-screen slice.

const props = defineProps<{
  sessionId: number | null;
  crawling: boolean;
  stopped: boolean;
}>();

const emit = defineEmits<{
  drill: [args: { tab: string; filterType?: string }];
}>();

interface HealthSnapshot {
  total: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  statusOther: number;
  errors: number;
  redirects: number;
  indexable: number;
  noindex: number;
  nofollow: number;
  emptyH1: number;
  emptyTitle: number;
  avgResponseTime: number;
  maxResponseTime: number;
}

const EMPTY: HealthSnapshot = {
  total: 0,
  status2xx: 0,
  status3xx: 0,
  status4xx: 0,
  status5xx: 0,
  statusOther: 0,
  errors: 0,
  redirects: 0,
  indexable: 0,
  noindex: 0,
  nofollow: 0,
  emptyH1: 0,
  emptyTitle: 0,
  avgResponseTime: 0,
  maxResponseTime: 0,
};

const health = ref<HealthSnapshot>(EMPTY);
const loading = ref(false);
const lastError = ref<string | null>(null);
const { crawlProgress } = useCrawl();

// Refresh debouncer — multiple rapid crawl-progress ticks coalesce into
// one aggregate_health round-trip so we don't hammer SQLite during a fast
// crawl. 300ms keeps the cards feeling live without blowing the budget.
//
// `pendingRefresh` covers the race where a tick lands while a fetch is
// in flight: instead of dropping that scheduled refresh on the floor (the
// previous behavior), we mark it pending and re-run after the current
// fetch finishes. Without this, the FINAL tick of a crawl was routinely
// lost and the hero card stuck at a mid-crawl value (e.g. 15,240) while
// the toolbar showed the true final count (16,063).
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshInFlight = false;
let pendingRefresh = false;

async function refreshNow() {
  if (props.sessionId == null) {
    health.value = EMPTY;
    return;
  }
  if (refreshInFlight) {
    pendingRefresh = true;
    return;
  }
  refreshInFlight = true;
  loading.value = true;
  try {
    const snap = await invoke<HealthSnapshot>("aggregate_health", { sessionId: props.sessionId });
    health.value = snap;
    lastError.value = null;
  } catch (e) {
    console.error("aggregate_health failed:", e);
    lastError.value = String(e);
  } finally {
    loading.value = false;
    refreshInFlight = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      void refreshNow();
    }
  }
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshNow();
  }, 300);
}

onMounted(() => { void refreshNow(); });
watch(() => props.sessionId, () => { void refreshNow(); });
watch(() => crawlProgress.value.rowCount, scheduleRefresh);
// Force a refresh whenever the crawl flips state — catches the moment
// after a stop / completion where rowCount lands at its final value but
// the in-flight refresh from a prior tick was already running with stale
// data. Without this watcher the hero stayed off-by-N until the user
// switched tabs.
watch(() => props.crawling, () => { void refreshNow(); });

// Hero status — uses the live progress ref (lower latency than aggregate)
// when a crawl is active, otherwise reflects the saved snapshot.
const heroStatus = computed(() => {
  if (props.crawling) return "CRAWLING";
  if (props.stopped) return "STOPPED";
  if (health.value.total > 0) return "COMPLETE";
  return "READY";
});
const heroRowCount = computed(() => props.crawling ? crawlProgress.value.rowCount : health.value.total);
const heroErrorCount = computed(() => props.crawling ? crawlProgress.value.errorCount : health.value.errors);

// Capture-rate metrics. Empty-h1 / empty-title rates flip the card
// amber→red according to the plan's threshold rules.
const emptyH1Pct = computed(() => pct(health.value.emptyH1, health.value.total));
const emptyTitlePct = computed(() => pct(health.value.emptyTitle, health.value.total));

function pct(n: number, total: number): number {
  if (!total) return 0;
  return Math.round((n / total) * 100);
}

function pctStr(n: number, total: number): string {
  if (!total) return "—";
  return `${pct(n, total)}%`;
}

// Card severity — drives the left-edge accent stripe. Threshold sources
// inline so the rules are visible in code review next to the cards they
// govern (rather than buried in a config file).
type Severity = "ok" | "amber" | "red";
function statusMixSeverity(): Severity {
  if (!health.value.total) return "ok";
  const errPct = ((health.value.status4xx + health.value.status5xx) / health.value.total) * 100;
  if (errPct >= 25) return "red";
  if (errPct >= 10) return "amber";
  return "ok";
}
function emptyH1Severity(): Severity {
  if (emptyH1Pct.value >= 50) return "red";
  if (emptyH1Pct.value >= 25) return "amber";
  return "ok";
}
function emptyTitleSeverity(): Severity {
  if (emptyTitlePct.value >= 25) return "red";
  if (emptyTitlePct.value >= 10) return "amber";
  return "ok";
}
function indexabilitySeverity(): Severity {
  if (!health.value.total) return "ok";
  const noindexPct = (health.value.noindex / health.value.total) * 100;
  // Saving 10%+ of pages as noindex is usually unintentional.
  if (noindexPct >= 25) return "red";
  if (noindexPct >= 10) return "amber";
  return "ok";
}

function avgResponseTime(): string {
  const v = health.value.avgResponseTime;
  if (!v) return "—";
  return `${Math.round(v)}ms`;
}

function maxResponseTime(): string {
  const v = health.value.maxResponseTime;
  if (!v) return "—";
  return `${v}ms`;
}
</script>

<template>
  <div class="health-screen">
    <!-- Hero status card -->
    <div class="hero-card" :class="`hero-card--${heroStatus.toLowerCase()}`">
      <div class="hero-status-label">CRAWL STATUS</div>
      <div class="hero-status-value">
        <span class="hero-status-dot" :class="`hero-status-dot--${heroStatus.toLowerCase()}`"></span>
        {{ heroStatus }}
      </div>
      <div class="hero-stats">
        <div class="hero-stat">
          <div class="hero-stat-label">PAGES</div>
          <div class="hero-stat-value">{{ heroRowCount.toLocaleString() }}</div>
        </div>
        <div class="hero-stat">
          <div class="hero-stat-label">ERRORS</div>
          <div class="hero-stat-value" :class="{ 'hero-stat-value--bad': heroErrorCount > 0 }">{{ heroErrorCount.toLocaleString() }}</div>
        </div>
        <div class="hero-stat">
          <div class="hero-stat-label">AVG RESPONSE</div>
          <div class="hero-stat-value">{{ avgResponseTime() }}</div>
        </div>
        <div class="hero-stat">
          <div class="hero-stat-label">MAX RESPONSE</div>
          <div class="hero-stat-value">{{ maxResponseTime() }}</div>
        </div>
      </div>
      <div v-if="crawlProgress.lastUrl && crawling" class="hero-last-url" :title="crawlProgress.lastUrl">
        Last: {{ crawlProgress.lastUrl }}
      </div>
    </div>

    <!-- Card grid -->
    <div class="cards-grid">
      <!-- Status code mix -->
      <div class="card" :class="`card--${statusMixSeverity()}`">
        <div class="card-title">STATUS CODES</div>
        <div class="card-body status-mix">
          <button class="status-row" @click="emit('drill', { tab: 'Response Codes', filterType: '2xx' })">
            <span class="status-dot status-dot--ok"></span>
            <span class="status-label">2xx OK</span>
            <span class="status-count">{{ health.status2xx.toLocaleString() }}</span>
          </button>
          <button class="status-row" @click="emit('drill', { tab: 'Response Codes', filterType: '3xx' })">
            <span class="status-dot status-dot--warn"></span>
            <span class="status-label">3xx Redirects</span>
            <span class="status-count">{{ health.status3xx.toLocaleString() }}</span>
          </button>
          <button class="status-row" @click="emit('drill', { tab: 'Response Codes', filterType: '4xx' })">
            <span class="status-dot status-dot--bad"></span>
            <span class="status-label">4xx Client</span>
            <span class="status-count">{{ health.status4xx.toLocaleString() }}</span>
          </button>
          <button class="status-row" @click="emit('drill', { tab: 'Response Codes', filterType: '5xx' })">
            <span class="status-dot status-dot--bad"></span>
            <span class="status-label">5xx Server</span>
            <span class="status-count">{{ health.status5xx.toLocaleString() }}</span>
          </button>
        </div>
      </div>

      <!-- Indexability -->
      <div class="card" :class="`card--${indexabilitySeverity()}`">
        <div class="card-title">INDEXABILITY</div>
        <div class="card-body status-mix">
          <button class="status-row" @click="emit('drill', { tab: 'Directives' })">
            <span class="status-dot status-dot--ok"></span>
            <span class="status-label">Indexable</span>
            <span class="status-count">{{ pctStr(health.indexable, health.total) }}</span>
          </button>
          <button class="status-row" @click="emit('drill', { tab: 'Directives' })">
            <span class="status-dot status-dot--bad"></span>
            <span class="status-label">Noindex</span>
            <span class="status-count">{{ pctStr(health.noindex, health.total) }}</span>
          </button>
          <button class="status-row" @click="emit('drill', { tab: 'Directives' })">
            <span class="status-dot status-dot--warn"></span>
            <span class="status-label">Nofollow</span>
            <span class="status-count">{{ pctStr(health.nofollow, health.total) }}</span>
          </button>
        </div>
      </div>

      <!-- Issues / quality -->
      <div class="card" :class="`card--${emptyH1Severity() === 'red' || emptyTitleSeverity() === 'red' ? 'red' : emptyH1Severity() === 'amber' || emptyTitleSeverity() === 'amber' ? 'amber' : 'ok'}`">
        <div class="card-title">CONTENT GAPS</div>
        <div class="card-body status-mix">
          <button class="status-row" @click="emit('drill', { tab: 'Page Titles' })">
            <span class="status-dot" :class="emptyTitleSeverity() === 'ok' ? 'status-dot--ok' : 'status-dot--bad'"></span>
            <span class="status-label">Missing &lt;title&gt;</span>
            <span class="status-count">{{ pctStr(health.emptyTitle, health.total) }}</span>
          </button>
          <button class="status-row" @click="emit('drill', { tab: 'H1' })">
            <span class="status-dot" :class="emptyH1Severity() === 'ok' ? 'status-dot--ok' : emptyH1Severity() === 'amber' ? 'status-dot--warn' : 'status-dot--bad'"></span>
            <span class="status-label">Missing H1</span>
            <span class="status-count">{{ pctStr(health.emptyH1, health.total) }}</span>
          </button>
          <button class="status-row" @click="emit('drill', { tab: 'Issues' })">
            <span class="status-dot status-dot--bad"></span>
            <span class="status-label">All issues</span>
            <span class="status-count">→</span>
          </button>
        </div>
      </div>

      <!-- Redirects + errors -->
      <div class="card" :class="`card--${health.errors > 0 ? 'red' : health.redirects > 0 ? 'amber' : 'ok'}`">
        <div class="card-title">FLOW &amp; FAULTS</div>
        <div class="card-body status-mix">
          <button class="status-row" @click="emit('drill', { tab: 'Response Codes', filterType: '3xx' })">
            <span class="status-dot status-dot--warn"></span>
            <span class="status-label">Redirects</span>
            <span class="status-count">{{ health.redirects.toLocaleString() }}</span>
          </button>
          <button class="status-row" @click="emit('drill', { tab: 'Issues' })">
            <span class="status-dot status-dot--bad"></span>
            <span class="status-label">Errors (req-fail)</span>
            <span class="status-count">{{ health.errors.toLocaleString() }}</span>
          </button>
          <button class="status-row" @click="emit('drill', { tab: 'Response Codes' })">
            <span class="status-dot status-dot--info"></span>
            <span class="status-label">Total pages</span>
            <span class="status-count">{{ health.total.toLocaleString() }}</span>
          </button>
        </div>
      </div>
    </div>

    <div v-if="lastError" class="health-error">aggregate_health failed: {{ lastError }}</div>
    <div v-if="!props.sessionId" class="health-empty">No active session — start a crawl or open a saved one.</div>
  </div>
</template>

<style scoped>
.health-screen {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  background: #0c111d;
}

/* Hero card — large, distinct from the regular cards. */
.hero-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  border-left-width: 4px;
}
.hero-card--crawling { border-left-color: #4ec9b0; }
.hero-card--stopped { border-left-color: #dcdcaa; }
.hero-card--complete { border-left-color: #569cd6; }
.hero-card--ready { border-left-color: rgba(255, 255, 255, 0.12); }

.hero-status-label {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  color: rgba(255, 255, 255, 0.45);
  text-transform: uppercase;
}

.hero-status-value {
  font-size: 16px;
  font-weight: 700;
  color: #ffffff;
  display: flex;
  align-items: center;
  gap: 10px;
  font-variant-numeric: tabular-nums;
}

.hero-status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}
.hero-status-dot--crawling {
  background: #4ec9b0;
  box-shadow: 0 0 8px rgba(78, 201, 176, 0.6);
  animation: pulse 1.5s infinite;
}
.hero-status-dot--stopped { background: #dcdcaa; }
.hero-status-dot--complete { background: #569cd6; }
.hero-status-dot--ready { background: rgba(255, 255, 255, 0.25); }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.hero-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 16px;
}
.hero-stat-label {
  font-size: 8px;
  font-weight: 600;
  letter-spacing: 1.5px;
  color: rgba(255, 255, 255, 0.45);
  text-transform: uppercase;
  margin-bottom: 4px;
}
.hero-stat-value {
  font-size: 16px;
  font-weight: 700;
  color: #ffffff;
  font-variant-numeric: tabular-nums;
}
.hero-stat-value--bad { color: #f44747; }

.hero-last-url {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
  font-family: 'SF Mono', 'Cascadia Code', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Card grid */
.cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}

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
.card--amber { border-left-color: #dcdcaa; }
.card--red { border-left-color: #f44747; }

.card-title {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  color: rgba(255, 255, 255, 0.45);
  text-transform: uppercase;
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* Status row — all rows in cards are buttons (every card click = a drill). */
.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: none;
  border: none;
  border-radius: 5px;
  color: rgba(255, 255, 255, 0.7);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s ease;
  font-variant-numeric: tabular-nums;
}
.status-row:hover {
  background: rgba(86, 156, 214, 0.08);
  color: #ffffff;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot--ok { background: #4ec9b0; }
.status-dot--warn { background: #dcdcaa; }
.status-dot--bad { background: #f44747; }
.status-dot--info { background: #569cd6; }

.status-label {
  flex: 1;
}

.status-count {
  font-weight: 600;
  color: #ffffff;
}

.health-error {
  padding: 8px 12px;
  background: rgba(244, 71, 71, 0.1);
  border: 1px solid rgba(244, 71, 71, 0.3);
  border-radius: 8px;
  color: #f44747;
  font-size: 11px;
}

.health-empty {
  padding: 24px;
  text-align: center;
  color: rgba(255, 255, 255, 0.25);
  font-size: 11px;
}
</style>
