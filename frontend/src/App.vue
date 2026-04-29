<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import MenuBar from "./components/MenuBar.vue";
import CategoryTabs from "./components/CategoryTabs.vue";
import FilterBar from "./components/FilterBar.vue";
import CrawlGrid from "./components/CrawlGrid.vue";
import HealthScreen from "./components/HealthScreen.vue";
import RightSidebar from "./components/RightSidebar.vue";
import BottomPanel from "./components/BottomPanel.vue";
import ConfigModal from "./components/ConfigModal.vue";
import ScraperModal from "./components/ScraperModal.vue";
import ReportPanel from "./components/ReportPanel.vue";
import AboutModal from "./components/AboutModal.vue";
import ProfileViewer from "./components/ProfileViewer.vue";
import CrawlManager from "./components/CrawlManager.vue";
import BlockAlert from "./components/BlockAlert.vue";
import SettingsPanel from "./components/settings/SettingsPanel.vue";
import DebugPanel from "./components/debug/DebugPanel.vue";
import VoiceRecorderModal from "./components/VoiceRecorderModal.vue";
import { useDebug } from "./composables/useDebug";
import { useSettings } from "./composables/useSettings";
import { useCrawl } from "./composables/useCrawl";
import { preloadVoiceModel } from "./composables/useVoiceInput";
import { useVoiceFlow } from "./composables/useVoiceFlow";
import { useConfig } from "./composables/useConfig";
import { useFileOps } from "./composables/useFileOps";
import { useBrowser } from "./composables/useBrowser";
import { useDatabase } from "./composables/useDatabase";
import { extractPastedUrls } from "./utils/pastedUrls";
import type { CrawlResult } from "./types/crawl";

const url = ref("");
// Scope dropdown and Mode menu were both nuked. Default behavior is
// Subdomain spider. List mode is now triggered by pasting 2+ URLs into
// the URL input — see onUrlPaste below. Single-URL "Exact URL" scope
// is reachable by pasting one URL into a fresh input + clicking start
// (same single-page semantics).
const crawlScope = ref("Subdomain");
const { config } = useConfig();
const { crawling, stopped, currentSessionId, crawlProgress, startCrawl, stopCrawl, clearResults, loadSession } = useCrawl();
const voiceFlow = useVoiceFlow();
const voiceModalOpen = ref(false);

// Auto-close once the turn fully completes (idle after speaking).
watch(() => voiceFlow.state.value, (s, prev) => {
  if (voiceModalOpen.value && s === "idle" && prev && prev !== "idle") {
    voiceModalOpen.value = false;
  }
});

async function handleVoicePress() {
  if (voiceFlow.state.value === "error") {
    // Press during error state = dismiss + retry
    voiceModalOpen.value = false;
    await voiceFlow.press();
    return;
  }
  if (!voiceModalOpen.value) voiceModalOpen.value = true;
  await voiceFlow.press();
}

async function handleVoiceCancel() {
  await voiceFlow.cancel();
  voiceModalOpen.value = false;
}
const { saveCrawl, openCrawl, exportCsv, exportFilteredCsv } = useFileOps();
const { profileData } = useBrowser();
const { start: startDebugListeners } = useDebug();
const { settings, effectiveSettings, init: initSettings, patch: patchSetting } = useSettings();

// Auto-show profile viewer when cookies arrive after sign-in
watch(profileData, (data) => {
  if (data && data.cookies.length > 0) {
    showProfile.value = true;
  }
});

// On startup: useCrawl() rehydrates the latest incomplete session (if any).
// No more closeOrphanedSessions — that silently marked stopped crawls as
// complete, hiding them from the user. Now they auto-resume; if the user
// wants a fresh start they explicitly Clear.
onMounted(async () => {
  // Start debug listeners app-wide so logs accumulate even when panel is closed.
  try {
    await startDebugListeners();
  } catch (e) {
    console.error("Debug listener error:", e);
  }
  // Load profiles + seed on first run so settings are ready before any crawl.
  try {
    await initSettings();
  } catch (e) {
    console.error("Settings init error:", e);
  }
  window.addEventListener("keydown", onGlobalKeydown);

  // Spin up the STT worker + start downloading the model in the background
  // so the first "/" press doesn't block on a cold load.
  preloadVoiceModel();

  try {
    browserInstallUnlisteners.push(
      await listen<{ name: string; meta?: Record<string, unknown> }>("sidecar-phase", (event) => {
        const name = event.payload.name;
        if (name === "browser-install-start") {
          if (browserInstallTimer) {
            clearTimeout(browserInstallTimer);
            browserInstallTimer = null;
          }
          browserInstallNotice.value = {
            state: "running",
            text: "Browser runtime is missing. Downloading Patchright Chromium now...",
          };
        } else if (name === "browser-install-complete") {
          browserInstallNotice.value = {
            state: "done",
            text: "Browser runtime installed. Starting the crawl...",
          };
          browserInstallTimer = setTimeout(() => {
            browserInstallNotice.value = null;
            browserInstallTimer = null;
          }, 5000);
        } else if (name === "browser-install-failed") {
          const msg = String(event.payload.meta?.error ?? "Download failed. Check your network and try again.");
          browserInstallNotice.value = {
            state: "failed",
            text: `Browser runtime download failed. ${msg}`,
          };
        }
      }),
    );
    browserInstallUnlisteners.push(
      await listen("crawl-started", () => {
        if (browserInstallTimer) {
          clearTimeout(browserInstallTimer);
          browserInstallTimer = null;
        }
        browserInstallNotice.value = null;
      }),
    );
  } catch (e) {
    console.error("Browser installer listener setup failed:", e);
  }
});

const browserInstallUnlisteners: UnlistenFn[] = [];

const showProfile = ref(false);
const configSection = ref<string | null>(null);
const scraperOpen = ref(false);
const activeReport = ref<string | null>(null);
const showAbout = ref(false);
const showCrawlManager = ref(false);
const activeCategory = ref("Internal");
const selectedResult = ref<CrawlResult | null>(null);
const searchQuery = ref("");
const filterType = ref("All");
const selectAllTrigger = ref(0);
const filteredCount = ref(0);

// CrawlGrid lives in remote-mode against query_results. We bump
// gridRefreshKey whenever the grid should re-issue its query — currently:
// every crawl-progress tick (so live counts and new rows reach the user
// without per-row events). 500ms cadence matches the Rust emitter.
const gridRefreshKey = ref(0);
watch(() => crawlProgress.value.rowCount, () => { gridRefreshKey.value++; });

// Phase 5: top-level HEALTH | DATA nav. Default HEALTH per the plan —
// a fresh launch lands on the dashboard summary, the grid is one click
// away. Click-throughs from health cards switch screen + seed the grid
// filter inputs in lockstep.
type Screen = "HEALTH" | "DATA";
const screen = ref<Screen>("HEALTH");

function handleHealthDrill(args: { tab: string; filterType?: string }) {
  activeCategory.value = args.tab;
  filterType.value = args.filterType ?? "All";
  screen.value = "DATA";
}
const browserInstallNotice = ref<{ state: "running" | "done" | "failed"; text: string } | null>(null);
let browserInstallTimer: ReturnType<typeof setTimeout> | null = null;

const bottomPanelHeight = ref(parseInt(localStorage.getItem('fera-bottom-height') || '200', 10));
const sidebarWidth = ref(parseInt(localStorage.getItem('fera-sidebar-width') || '250', 10));
let resizing: 'bottom' | 'sidebar' | null = null;
let startPos = 0;
let startSize = 0;

function startResize(type: 'bottom' | 'sidebar', e: MouseEvent) {
  resizing = type;
  startPos = type === 'bottom' ? e.clientY : e.clientX;
  startSize = type === 'bottom' ? bottomPanelHeight.value : sidebarWidth.value;
  document.addEventListener('mousemove', onResize);
  document.addEventListener('mouseup', stopResize);
  document.body.style.cursor = type === 'bottom' ? 'row-resize' : 'col-resize';
  document.body.style.userSelect = 'none';
}

function onResize(e: MouseEvent) {
  if (!resizing) return;
  if (resizing === 'bottom') {
    const delta = startPos - e.clientY;
    bottomPanelHeight.value = Math.max(80, Math.min(500, startSize + delta));
  } else {
    const delta = startPos - e.clientX;
    sidebarWidth.value = Math.max(150, Math.min(500, startSize + delta));
  }
}

function stopResize() {
  if (resizing === 'bottom') localStorage.setItem('fera-bottom-height', String(bottomPanelHeight.value));
  else if (resizing === 'sidebar') localStorage.setItem('fera-sidebar-width', String(sidebarWidth.value));
  resizing = null;
  document.removeEventListener('mousemove', onResize);
  document.removeEventListener('mouseup', stopResize);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

const hasRecrawlQueue = computed(() => config.recrawlQueue.length > 0);

function handleResumeRecrawl() {
  if (!config.recrawlQueue.length || crawling.value) return;
  handleRecrawl([...config.recrawlQueue]);
}

function handleClearRecrawlQueue() {
  config.recrawlQueue = [];
}

// "Clicking the action button will resume" — true whenever there's data we
// could pick up from. Matches handleStart's isResume check so the button
// label never lies about what clicking does. Survives HMR-induced loss of
// the `stopped` flag because results.length is the actual signal.
const isResumable = computed(() => stopped.value || crawlProgress.value.rowCount > 0);

const statusText = computed(() => {
  if (crawling.value) return "CRAWLING";
  if (stopped.value) return "STOPPED";
  if (crawlProgress.value.rowCount > 0) return "COMPLETE";
  return "IDLE";
});

function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) return "https://" + s;
  return s;
}

async function onUrlPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData("text") ?? "";
  const urls = extractPastedUrls(text);
  if (urls.length < 2) return; // single URL — let the native paste land in the input
  event.preventDefault();
  // Switch the active settings into list mode AND seed the URL list in
  // one place. Two patches because they target different sections; the
  // computed effectiveSettings recomputes after each so the badge and
  // the readout update together on the next render.
  await patchSetting("crawling", "mode", "list");
  await patchSetting("inputs", "urls", urls);
  // The input is unmounted by the v-if as soon as mode flips, but if
  // some browser still holds focus on it, clear the visible value so a
  // stale single URL doesn't sit there.
  url.value = "";
}

function canStart(): boolean {
  if (crawling.value) return false;
  if (effectiveSettings.value.crawling.mode === "list") return config.urls.length > 0;
  return !!url.value.trim();
}

// Probe modal "Save settings & resume" → BlockAlert applied the row's config
// to settings and (optionally) wiped the profile. Now stop the running
// sidecar and respawn with resume:true so excludeUrls skips done URLs.
async function onApplyProbeAndResume() {
  if (crawling.value) {
    try { await stopCrawl(); } catch (e) { console.error("stopCrawl failed:", e); }
    // Give the sidecar a moment to actually exit (kill is async).
    await new Promise((r) => setTimeout(r, 800));
  }
  handleStart();
}

async function handleStart() {
  // Treat any START click with existing results as a resume — never silently
  // wipe a partial crawl. To start fresh, the user must explicitly Clear.
  const isResume = stopped.value || crawlProgress.value.rowCount > 0;
  // Read mode from effectiveSettings — pinned snapshot when a saved crawl is
  // loaded, default profile otherwise. Reading settings.value here would
  // silently use the default profile's mode for a loaded list crawl, routing
  // the resume through the spider branch.
  const activeMode = effectiveSettings.value.crawling.mode;
  try {
    if (activeMode === "list") {
      if (!config.urls.length) return;
      await startCrawl(config.urls[0], { resume: isResume });
    } else {
      if (!url.value.trim()) return;
      url.value = normalizeUrl(url.value);
      if (crawlScope.value === "Exact URL") {
        // Per-call override — don't mutate the profile's mode for a one-off scope.
        await startCrawl(url.value, { resume: isResume, mode: "list", urls: [url.value] });
      } else {
        await startCrawl(url.value, { resume: isResume });
      }
    }
  } catch (e) {
    // Surface the resume-without-session guard (and any other startCrawl
    // throw) directly — silent fragmentation is worse than an interruption.
    alert((e as Error).message ?? String(e));
  }
}

const showClearConfirm = ref(false);
const showSettingsPanel = ref(false);
const showDebugPanel = ref(false);

function onGlobalKeydown(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === ",") {
    e.preventDefault();
    showSettingsPanel.value = true;
    return;
  }
  // Cmd/Ctrl+Shift+D opens debug
  if (mod && e.shiftKey && (e.key === "D" || e.key === "d")) {
    e.preventDefault();
    showDebugPanel.value = true;
    return;
  }
  // "/" toggles voice mode (skip when user is typing in any input/textarea).
  if (e.key === "/" && !mod && !e.altKey) {
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
    e.preventDefault();
    handleVoicePress();
    return;
  }
  // Esc cancels recording / dismisses error modal.
  if (e.key === "Escape" && voiceModalOpen.value) {
    e.preventDefault();
    handleVoiceCancel();
    return;
  }
}


async function handleClear() {
  if (crawlProgress.value.rowCount > 0) {
    showClearConfirm.value = true;
    return;
  }
  doClear();
}

async function handleSaveAndClear() {
  const saved = await saveCrawl(currentSessionId.value, config);
  if (!saved) return; // user cancelled the save dialog
  showClearConfirm.value = false;
  doClear();
}

function handleClearWithoutSave() {
  showClearConfirm.value = false;
  doClear();
}

function doClear() {
  clearResults();
  url.value = "";
  selectedResult.value = null;
}

function onRowSelect(result: CrawlResult | null) {
  selectedResult.value = result;
}

async function handleRecrawl(urls: string[]) {
  if (!urls.length || crawling.value) return;
  config.recrawlQueue = [...urls];
  await startCrawl(urls[0], {
    resume: true,
    replaceUrls: new Set(urls),
    mode: "list",
    urls,
    maxRequests: urls.length,
  });
}

function handleLoadSession(sessionUrl: string) {
  url.value = sessionUrl;
  showCrawlManager.value = false;
}

onUnmounted(() => {
  if (resizing) stopResize();
  window.removeEventListener("keydown", onGlobalKeydown);
  for (const u of browserInstallUnlisteners) u();
  if (browserInstallTimer) clearTimeout(browserInstallTimer);
});

async function handleMenuAction(menu: string, item: string) {
  if (menu === "File") {
    if (item === "New Crawl") { handleClear(); }
    else if (item === "Saved Crawls...") { showCrawlManager.value = true; }
    else if (item === "Open...") {
      // Phase-6 note: .fera files store snapshot rows from the legacy
      // in-memory array. Re-loading those rows into the new architecture
      // means writing them back to a fresh DB session, which the existing
      // Tauri commands don't expose yet. For now the Open flow only
      // restores the config slice (URLs / headers / scraper rules) so the
      // user can re-run the same crawl; the saved-session path
      // (Crawl Manager) is unaffected and remains the primary recovery
      // route.
      const data = await openCrawl();
      if (data?.config) {
        if (Array.isArray(data.config.urls)) config.urls = [...data.config.urls];
        if (data.config.customHeaders) config.customHeaders = { ...data.config.customHeaders };
        if (Array.isArray(data.config.scraperRules)) config.scraperRules = [...data.config.scraperRules];
        if (Array.isArray(data.config.recrawlQueue)) config.recrawlQueue = [...data.config.recrawlQueue];
      }
    }
    else if (item === "Save As...") { await saveCrawl(currentSessionId.value, config); }
    else if (item === "Export CSV") { await exportCsv(currentSessionId.value); }
    else if (item === "Export Excel") { await exportFilteredCsv(currentSessionId.value, () => true, "crawl-export"); }
    else if (item === "Exit") { await getCurrentWindow().close(); }
  }
  if (menu === "Configuration") {
    if (item === "Scraper") scraperOpen.value = true;
    else showSettingsPanel.value = true;
  }
  if (menu === "Export") {
    const f: Record<string, (r: CrawlResult) => boolean> = {
      "Internal HTML": (r) => (r.resourceType || "HTML") === "HTML",
      "All Links": () => true, "Response Codes": (r) => r.status >= 400,
      "Page Titles": (r) => !!r.title, Redirects: (r) => r.status >= 300 && r.status < 400,
    };
    await exportFilteredCsv(currentSessionId.value, f[item] ?? (() => true), item.toLowerCase().replace(/\s+/g, "-"));
  }
  if (menu === "Reports") {
    const m: Record<string, string> = { "Crawl Overview": "overview", "Redirect Chains": "redirects", "Duplicate Content": "duplicates", "Orphan Pages": "orphans" };
    activeReport.value = m[item] ?? null;
  }
  if (menu === "Help") {
    if (item === "About Fera") showAbout.value = true;
    else if (item === "Documentation") { const { openUrl } = await import("@tauri-apps/plugin-opener"); await openUrl("https://github.com/dsottimano/fera-crawler"); }
  }
}
</script>

<template>
  <div class="app">
    <MenuBar @action="handleMenuAction" />

    <!-- ── Telemetry bar ── -->
    <header class="telemetry-bar">
      <div class="telem-logo">
        <img src="/logo.svg" alt="Fera" class="logo-img" />
        <div class="logo-label">
          <span class="logo-name">Fera</span>
          <span class="logo-mode">Crawler</span>
        </div>
      </div>

      <div class="telem-divider"></div>

        <!-- Status -->
        <div class="telem-stat">
          <span class="telem-label">STATUS</span>
          <span class="telem-value" :class="{ 'val-active': crawling, 'val-stopped': stopped, 'val-done': !crawling && !stopped && crawlProgress.rowCount > 0 }">
            <span class="status-dot"></span>
            {{ statusText }}
          </span>
        </div>

        <!-- URL input (compact) — reads `effectiveSettings` so a loaded
             list-mode session shows the LIST MODE badge instead of the
             default-profile's URL input. -->
        <div class="telem-url-group">
          <div class="telem-url-wrap">
            <div v-if="effectiveSettings.crawling.mode === 'list'" class="telem-list-badge" @click="showSettingsPanel = true">
              LIST MODE — {{ effectiveSettings.inputs.urls.length.toLocaleString() }} URL{{ effectiveSettings.inputs.urls.length !== 1 ? 's' : '' }}
            </div>
            <input
              v-else
              v-model="url"
              type="url"
              placeholder="https://example.com/  (or paste a list)"
              class="telem-url"
              :disabled="crawling"
              @keyup.enter="handleStart"
              @paste="onUrlPaste"
            />
          </div>
        </div>

        <!-- Pages crawled. List-mode shows X / Y so the user sees how
             many of the queued list have come back. Spider mode shows
             just the running count. -->
        <div class="telem-stat">
          <span class="telem-label">{{ effectiveSettings.crawling.mode === 'list' ? 'PAGES CRAWLED' : 'URLS FOUND' }}</span>
          <span class="telem-value telem-number">
            {{ crawlProgress.rowCount.toLocaleString() }}<template v-if="effectiveSettings.crawling.mode === 'list' && effectiveSettings.inputs.urls.length > 0"><span class="telem-number-sep"> / </span>{{ effectiveSettings.inputs.urls.length.toLocaleString() }}</template>
          </span>
        </div>

        <div class="telem-divider"></div>

        <!-- Actions -->
        <div class="telem-actions">
          <button class="btn-pill btn-go" :class="{ 'btn-resume': isResumable }" :disabled="!canStart()" @click="handleStart">
            {{ isResumable ? '&#x25B6; RESUME' : '&#x25B6; START' }}
          </button>
          <button v-if="crawling" class="btn-pill btn-stop" @click="stopCrawl">
            &#x25A0; STOP
          </button>
          <button class="btn-pill btn-reset" @click="handleClear">CLEAR</button>
          <button
            v-if="profileData"
            class="btn-pill btn-profile"
            @click="showProfile = true"
          >
            &#x1F36A; COOKIES
          </button>
          <button
            v-if="hasRecrawlQueue && !crawling"
            class="btn-pill btn-recrawl"
            :title="'Crawl the URLs queued for recrawl (' + config.recrawlQueue.length + '). They were added when you clicked Recrawl on rows in the grid. URLs leave the queue as they get re-crawled.'"
            @click="handleResumeRecrawl"
          >
            &#x21BB; RESUME RECRAWL ({{ config.recrawlQueue.length }})
          </button>
          <button
            v-if="hasRecrawlQueue && !crawling"
            class="btn-pill btn-recrawl-clear"
            title="Discard the recrawl queue without crawling. Removes the URLs from the queue but keeps them as rows in the grid."
            @click="handleClearRecrawlQueue"
          >
            &times; CLEAR QUEUE
          </button>
          <span class="actions-sep" aria-hidden="true"></span>
          <button class="btn-pill btn-settings" @click="showSettingsPanel = true" title="Cmd/Ctrl+,">
            &#x2699; SETTINGS
          </button>
          <button class="btn-pill btn-debug" @click="showDebugPanel = true" title="Cmd/Ctrl+Shift+D">
            &#x1F527; DEBUG
          </button>
        </div>

        <!-- Config badges: only show when set (delay + robots are visible
             in the right-sidebar Config tab; surface non-default per-crawl
             input state here as a heads-up). -->
        <div
          v-if="config.scraperRules.length > 0 || Object.keys(config.customHeaders).length > 0"
          class="config-badges"
        >
          <span v-if="config.scraperRules.length > 0" class="config-badge" :title="config.scraperRules.length + ' scraper rule(s)'">SCRAPER</span>
          <span v-if="Object.keys(config.customHeaders).length > 0" class="config-badge" :title="Object.keys(config.customHeaders).length + ' custom header(s)'">HEADERS</span>
        </div>
    </header>

    <BlockAlert @apply-probe-and-resume="onApplyProbeAndResume" />
    <div
      v-if="browserInstallNotice"
      class="browser-install-banner"
      :class="'browser-install-banner--' + browserInstallNotice.state"
    >
      <div class="browser-install-dot"></div>
      <div class="browser-install-text">{{ browserInstallNotice.text }}</div>
    </div>

    <!-- Phase-5 top-level nav: HEALTH | DATA. The data screen below is
         conditionally mounted; switching screens unmounts the other so
         their watchers / Tabulator instance / aggregate fetch loop don't
         keep running in the background. -->
    <nav class="screen-nav" role="tablist">
      <button
        class="screen-nav-tab"
        :class="{ 'screen-nav-tab--active': screen === 'HEALTH' }"
        :aria-selected="screen === 'HEALTH'"
        role="tab"
        @click="screen = 'HEALTH'"
      >HEALTH</button>
      <button
        class="screen-nav-tab"
        :class="{ 'screen-nav-tab--active': screen === 'DATA' }"
        :aria-selected="screen === 'DATA'"
        role="tab"
        @click="screen = 'DATA'"
      >DATA</button>
    </nav>

    <HealthScreen
      v-if="screen === 'HEALTH'"
      :session-id="currentSessionId"
      :crawling="crawling"
      :stopped="stopped"
      @drill="handleHealthDrill"
    />

    <template v-if="screen === 'DATA'">
      <CategoryTabs :active="activeCategory" :recrawl-count="config.recrawlQueue.length" @select="activeCategory = $event" />
      <FilterBar
        :total-results="crawlProgress.rowCount"
        :filtered-count="filteredCount"
        :active-tab="activeCategory"
        :session-id="currentSessionId"
        @search="searchQuery = $event"
        @filter-type="filterType = $event"
        @export="exportCsv(currentSessionId)"
        @select-all="selectAllTrigger++"
      />

      <div class="main-content">
        <div class="left-panels">
          <div class="grid-area">
            <CrawlGrid :session-id="currentSessionId" :active-tab="activeCategory" :filter-type="filterType" :search-query="searchQuery" :select-all="selectAllTrigger" :refresh-key="gridRefreshKey" @row-select="onRowSelect" @recrawl="handleRecrawl" @filtered-count="filteredCount = $event" />
          </div>
          <div class="grid-status-bar">
            <span>Selected Cells: 0</span>
            <span>Filter Total: {{ filteredCount }}</span>
          </div>
          <div class="resize-handle resize-handle--h" @mousedown="startResize('bottom', $event)"></div>
          <div :style="{ height: bottomPanelHeight + 'px', flexShrink: 0, overflow: 'hidden' }">
            <BottomPanel :selected-result="selectedResult" />
          </div>
        </div>
        <div class="resize-handle resize-handle--v" @mousedown="startResize('sidebar', $event)"></div>
        <div :style="{ width: sidebarWidth + 'px', flexShrink: 0, overflow: 'hidden' }">
          <RightSidebar :session-id="currentSessionId" :refresh-key="gridRefreshKey" @edit-settings="showSettingsPanel = true" />
        </div>
      </div>
    </template>
    <ConfigModal v-if="configSection" @close="configSection = null" />
    <ScraperModal v-if="scraperOpen" @close="scraperOpen = false" />
    <ReportPanel v-if="activeReport" :report="activeReport" :session-id="currentSessionId" @close="activeReport = null" />
    <AboutModal v-if="showAbout" @close="showAbout = false" />
    <CrawlManager
      v-if="showCrawlManager"
      @close="showCrawlManager = false"
      @load="handleLoadSession"
    />
    <ProfileViewer v-if="showProfile && profileData" :data="profileData" @close="showProfile = false" />
    <SettingsPanel v-if="showSettingsPanel" @close="showSettingsPanel = false" />
    <DebugPanel v-if="showDebugPanel" @close="showDebugPanel = false" />
    <VoiceRecorderModal
      :show="voiceModalOpen"
      :state="voiceFlow.state.value"
      :error-text="voiceFlow.errorText.value"
      :user-transcript="voiceFlow.userTranscript.value"
      :claude-text="voiceFlow.claudeText.value"
    />

    <!-- Clear confirm dialog -->
    <div v-if="showClearConfirm" class="overlay" @click.self="showClearConfirm = false">
      <div class="confirm-modal">
        <div class="confirm-header">Clear Results</div>
        <div class="confirm-body">Save crawl data before clearing?</div>
        <div class="confirm-actions">
          <button class="btn-pill btn-confirm-save" @click="handleSaveAndClear">SAVE &amp; CLEAR</button>
          <button class="btn-pill btn-confirm-discard" @click="handleClearWithoutSave">DISCARD</button>
          <button class="btn-pill btn-confirm-cancel" @click="showClearConfirm = false">CANCEL</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #0c111d;
}

/* Phase-5 top-level HEALTH | DATA tabs. Underline-active style mirrors
   the existing CategoryTabs row to feel like one navigation system. */
.screen-nav {
  display: flex;
  gap: 4px;
  padding: 0 16px;
  background: #0c111d;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}
.screen-nav-tab {
  background: none;
  border: none;
  padding: 10px 16px 8px;
  font-family: 'Ubuntu', sans-serif;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.45);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.15s ease;
}
.screen-nav-tab:hover {
  color: rgba(255, 255, 255, 0.7);
}
.screen-nav-tab--active {
  color: #569cd6;
  border-bottom-color: #569cd6;
}

.browser-install-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  min-height: 34px;
  padding: 7px 14px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  background: rgba(220, 220, 170, 0.1);
  color: #e6e1b5;
  font-size: 12px;
}

.browser-install-banner--done {
  background: rgba(78, 201, 176, 0.1);
  color: #9de0d4;
}

.browser-install-banner--failed {
  background: rgba(244, 71, 71, 0.12);
  color: #ffb0b0;
}

.browser-install-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 8px currentColor;
}

.browser-install-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* ── Telemetry bar ── */
.telemetry-bar {
  display: flex;
  align-items: center;
  /* Allow the bar to wrap to a second row at narrow widths instead of
     overflowing — the URL input was getting clipped on smaller windows.
     row-gap covers wrapped lines; column-gap is the original spacing. */
  flex-wrap: wrap;
  column-gap: 16px;
  row-gap: 8px;
  padding: 10px 20px;
  background: #0c111d;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  flex-shrink: 0;
}

.telem-logo {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  cursor: pointer;
  position: relative;
}
.telem-logo:hover .logo-mode { color: rgba(255,255,255,0.5); }

.logo-img {
  width: 24px;
  height: 24px;
  filter: drop-shadow(0 0 8px rgba(86,156,214,0.5));
}

.logo-label {
  display: flex;
  flex-direction: column;
  line-height: 1.1;
}

.logo-name {
  font-size: 14px;
  font-weight: 700;
  color: #ffffff;
  letter-spacing: 1px;
}

.logo-mode {
  font-size: 9px;
  font-weight: 500;
  color: rgba(255,255,255,0.35);
  letter-spacing: 0.8px;
  text-transform: uppercase;
  transition: color 0.15s;
}
.telem-divider {
  width: 1px;
  height: 28px;
  background: rgba(255,255,255,0.08);
  flex-shrink: 0;
}

.telem-stat {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex-shrink: 0;
}

.telem-label {
  font-size: 8px;
  font-weight: 600;
  color: rgba(255,255,255,0.25);
  letter-spacing: 1.5px;
  text-transform: uppercase;
}

.telem-value {
  font-size: 12px;
  font-weight: 600;
  color: #ffffff;
  display: flex;
  align-items: center;
  gap: 6px;
}

.telem-number {
  font-variant-numeric: tabular-nums;
  color: #569cd6;
  font-size: 16px;
  font-weight: 700;
}

/* Subdued separator inside the X / Y readout. Same fontsize so the
   numbers stay aligned, just lower contrast so the eye reads it as a
   denominator and not a third value. */
.telem-number-sep {
  color: rgba(255, 255, 255, 0.25);
  font-weight: 500;
}

.val-active { color: #4ec9b0; }
.val-stopped { color: #dcdcaa; }
.val-done { color: #569cd6; }

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255,255,255,0.2);
}

.val-active .status-dot {
  background: #4ec9b0;
  box-shadow: 0 0 8px rgba(78, 201, 176, 0.6);
  animation: pulse 1.5s infinite;
}

.val-stopped .status-dot {
  background: #dcdcaa;
  box-shadow: 0 0 8px rgba(220, 220, 170, 0.5);
}

.val-done .status-dot {
  background: #569cd6;
  box-shadow: 0 0 8px rgba(86, 156, 214, 0.5);
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* URL input — primary input, takes the lion's share of free horizontal
   space. min-width:0 lets it shrink past the input's intrinsic
   placeholder width when the bar is narrow; max-width caps growth on
   wide windows so the buttons don't drift to the far right edge. */
.telem-url-group {
  flex: 1 1 280px;
  min-width: 0;
  max-width: 640px;
}

.telem-url-wrap {
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 20px;
  background: rgba(255,255,255,0.04);
  overflow: hidden;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.telem-url-wrap:focus-within {
  border-color: rgba(86,156,214,0.5);
  box-shadow: 0 0 0 2px rgba(86,156,214,0.1);
}

.telem-url {
  width: 100%;
  padding: 8px 18px;
  border: none;
  background: transparent;
  color: #ffffff;
  font-size: 12px;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  outline: none;
}

.telem-url::placeholder {
  color: rgba(255,255,255,0.2);
}

.telem-list-badge {
  padding: 6px 16px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1px;
  color: #569cd6;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.15s;
}
.telem-list-badge:hover {
  color: #7cb8e8;
}

/* Action buttons — primary cluster (start/stop/clear/recrawl) gets tight
   spacing; an in-cluster gap separates it from secondary actions
   (cookies/settings/debug) so the eye groups them naturally. */
.telem-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  align-items: center;
}

.actions-sep {
  display: inline-block;
  width: 1px;
  height: 18px;
  background: rgba(255, 255, 255, 0.08);
  margin: 0 4px;
}

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
  box-shadow: 0 0 16px rgba(78,201,176,0.15);
}
.btn-go:disabled {
  opacity: 0.25;
  cursor: default;
}

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
.btn-reset:hover {
  color: #ffffff;
  border-color: rgba(255,255,255,0.25);
}

.btn-profile {
  color: #c586c0;
  border-color: rgba(197,134,192,0.3);
}
.btn-profile:hover {
  background: rgba(197,134,192,0.1);
  border-color: #c586c0;
  box-shadow: 0 0 16px rgba(197,134,192,0.15);
}
.btn-recrawl {
  color: #ce9178;
  border-color: rgba(206,145,120,0.3);
}
.btn-recrawl:hover {
  background: rgba(206,145,120,0.1);
  border-color: #ce9178;
  box-shadow: 0 0 16px rgba(206,145,120,0.15);
}

.btn-recrawl-clear {
  color: rgba(255,255,255,0.4);
  border-color: rgba(255,255,255,0.1);
}
.btn-recrawl-clear:hover {
  color: #f44747;
  border-color: rgba(244,71,71,0.3);
}

.btn-debug {
  color: rgba(255,255,255,0.5);
  border-color: rgba(255,255,255,0.12);
}
.btn-debug:hover {
  color: #569cd6;
  border-color: rgba(86,156,214,0.4);
  background: rgba(86,156,214,0.08);
}

.btn-settings {
  color: rgba(255,255,255,0.5);
  border-color: rgba(255,255,255,0.12);
}
.btn-settings:hover {
  color: #ffffff;
  border-color: rgba(255,255,255,0.3);
  background: rgba(255,255,255,0.04);
}


/* ── Main layout ── */
.main-content {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.left-panels {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.grid-area {
  flex: 1;
  overflow: hidden;
}

.grid-status-bar {
  display: flex;
  justify-content: space-between;
  padding: 3px 12px;
  font-size: 9px;
  color: rgba(255,255,255,0.2);
  background: #0c111d;
  border-top: 1px solid rgba(255,255,255,0.06);
  border-bottom: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
  letter-spacing: 0.5px;
}

/* ── Resize handles ── */
.resize-handle--h {
  height: 4px;
  cursor: row-resize;
  background: transparent;
  flex-shrink: 0;
  transition: background 0.15s;
}
.resize-handle--h:hover { background: rgba(86,156,214,0.3); }

.resize-handle--v {
  width: 4px;
  cursor: col-resize;
  background: transparent;
  flex-shrink: 0;
  transition: background 0.15s;
}
.resize-handle--v:hover { background: rgba(86,156,214,0.3); }

/* Resume button variant */
.btn-resume {
  color: #dcdcaa;
  border-color: rgba(220,220,170,0.3);
}
.btn-resume:hover:not(:disabled) {
  background: rgba(220,220,170,0.1);
  border-color: #dcdcaa;
  box-shadow: 0 0 16px rgba(220,220,170,0.15);
}

/* ── Clear confirm dialog ── */
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  backdrop-filter: blur(6px);
}
.confirm-modal {
  background: #141a2e;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 12px;
  padding: 20px;
  min-width: 340px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  color: #ffffff;
}
.confirm-header {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  margin-bottom: 12px;
}
.confirm-body {
  font-size: 12px;
  color: rgba(255,255,255,0.7);
  margin-bottom: 20px;
}
.confirm-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.btn-confirm-save {
  color: #4ec9b0;
  border-color: rgba(78,201,176,0.3);
}
.btn-confirm-save:hover {
  background: rgba(78,201,176,0.1);
  border-color: #4ec9b0;
}
.btn-confirm-discard {
  color: #f44747;
  border-color: rgba(244,71,71,0.3);
}
.btn-confirm-discard:hover {
  background: rgba(244,71,71,0.1);
  border-color: #f44747;
}
.btn-confirm-cancel {
  color: rgba(255,255,255,0.4);
  border-color: rgba(255,255,255,0.1);
}
.btn-confirm-cancel:hover {
  color: #ffffff;
  border-color: rgba(255,255,255,0.25);
}

.config-badges {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  flex-wrap: wrap;
  max-width: 200px;
}

.config-badge {
  padding: 3px 8px;
  border-radius: 14px;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: #569cd6;
  border: 1px solid rgba(86,156,214,0.25);
  background: rgba(86,156,214,0.06);
  white-space: nowrap;
}

</style>
