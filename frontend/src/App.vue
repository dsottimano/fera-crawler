<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import MenuBar from "./components/MenuBar.vue";
import CategoryTabs from "./components/CategoryTabs.vue";
import FilterBar from "./components/FilterBar.vue";
import CrawlGrid from "./components/CrawlGrid.vue";
import RightSidebar from "./components/RightSidebar.vue";
import BottomPanel from "./components/BottomPanel.vue";
import ConfigModal from "./components/ConfigModal.vue";
import ScraperModal from "./components/ScraperModal.vue";
import ReportPanel from "./components/ReportPanel.vue";
import AboutModal from "./components/AboutModal.vue";
import ProfileViewer from "./components/ProfileViewer.vue";
import CrawlManager from "./components/CrawlManager.vue";
import SettingsFinder from "./components/SettingsFinder.vue";
import SettingsPanel from "./components/settings/SettingsPanel.vue";
import DebugPanel from "./components/debug/DebugPanel.vue";
import { useDebug } from "./composables/useDebug";
import { useCrawl } from "./composables/useCrawl";
import { useConfig } from "./composables/useConfig";
import { useFileOps } from "./composables/useFileOps";
import { useBrowser } from "./composables/useBrowser";
import { useDatabase } from "./composables/useDatabase";
import type { CrawlResult, CrawlConfig } from "./types/crawl";

const url = ref("");
const crawlScope = ref("Subdomain");
const { config, applyConfig } = useConfig();
const { results, crawling, stopped, startCrawl, stopCrawl, clearResults, setResults, loadSession } = useCrawl();
const { saveCrawl, openCrawl, exportCsv, exportFilteredCsv } = useFileOps();
const { browserOpen, profileData, openBrowser, closeBrowser, fetchProfileData } = useBrowser();
const { closeOrphanedSessions } = useDatabase();
const { start: startDebugListeners } = useDebug();

// Auto-show profile viewer when cookies arrive after sign-in
watch(profileData, (data) => {
  if (data && data.cookies.length > 0) {
    showProfile.value = true;
  }
});

// On startup: close any orphaned sessions (but don't auto-load — start clean)
onMounted(async () => {
  try {
    await closeOrphanedSessions();
  } catch (e) {
    console.error("DB startup error:", e);
  }
  // Start debug listeners app-wide so logs accumulate even when panel is closed.
  try {
    await startDebugListeners();
  } catch (e) {
    console.error("Debug listener error:", e);
  }
  window.addEventListener("keydown", onGlobalKeydown);
});

const activeMode = ref<"crawler" | "settings-finder">("crawler");
const showModeMenu = ref(false);
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
const recrawlQueueAll = ref<string[]>([]);

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

const modeLabel = computed(() => {
  return activeMode.value === "crawler" ? "Crawler Mode" : "Settings Finder";
});

function selectMode(mode: "crawler" | "settings-finder") {
  activeMode.value = mode;
  showModeMenu.value = false;
}

const hasRecrawlQueue = computed(() => config.recrawlQueue.length > 0);

function handleResumeRecrawl() {
  if (!config.recrawlQueue.length || crawling.value) return;
  handleRecrawl([...config.recrawlQueue]);
}

const statusText = computed(() => {
  if (crawling.value) return "CRAWLING";
  if (stopped.value) return "STOPPED";
  if (results.value.length) return "COMPLETE";
  return "IDLE";
});

function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) return "https://" + s;
  return s;
}

function canStart(): boolean {
  if (crawling.value) return false;
  if (config.mode === "list") return config.urls.length > 0;
  return !!url.value.trim();
}

function handleStart() {
  const isResume = stopped.value;
  if (config.mode === "list") {
    if (!config.urls.length) return;
    startCrawl(config.urls[0], config, isResume);
  } else {
    if (!url.value.trim()) return;
    url.value = normalizeUrl(url.value);
    if (crawlScope.value === "Exact URL") {
      config.mode = "list";
      config.urls = [url.value];
    }
    startCrawl(url.value, config, isResume);
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
  }
  // Cmd/Ctrl+Shift+D opens debug
  if (mod && e.shiftKey && (e.key === "D" || e.key === "d")) {
    e.preventDefault();
    showDebugPanel.value = true;
  }
}


async function handleClear() {
  if (results.value.length > 0) {
    showClearConfirm.value = true;
    return;
  }
  doClear();
}

async function handleSaveAndClear() {
  const saved = await saveCrawl(results.value, config);
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
  recrawlQueueAll.value = [...urls];
  config.recrawlQueue = [...urls];
  const replaceSet = new Set(urls);
  const recrawlConfig: CrawlConfig = {
    ...config,
    mode: "list",
    urls,
    maxRequests: urls.length,
  };
  await startCrawl(urls[0], recrawlConfig, true, replaceSet);
}

function handleLoadSession(sessionUrl: string) {
  url.value = sessionUrl;
  if (config.recrawlQueue.length > 0) recrawlQueueAll.value = [...config.recrawlQueue];
  showCrawlManager.value = false;
}

onUnmounted(() => {
  if (resizing) stopResize();
  window.removeEventListener("keydown", onGlobalKeydown);
});

async function handleMenuAction(menu: string, item: string) {
  if (menu === "File") {
    if (item === "New Crawl") { handleClear(); }
    else if (item === "Saved Crawls...") { showCrawlManager.value = true; }
    else if (item === "Open...") {
      const data = await openCrawl();
      if (data) {
        setResults(data.results);
        if (data.config) {
          applyConfig(data.config);
          if (config.recrawlQueue.length > 0) recrawlQueueAll.value = [...config.recrawlQueue];
        }
      }
    }
    else if (item === "Save As...") { await saveCrawl(results.value, config); }
    else if (item === "Export CSV") { await exportCsv(results.value); }
    else if (item === "Export Excel") { await exportFilteredCsv(results.value, () => true, "crawl-export"); }
    else if (item === "Exit") { await getCurrentWindow().close(); }
  }
  if (menu === "Configuration") {
    if (item === "Scraper") scraperOpen.value = true;
    else configSection.value = "settings";
  }
  if (menu === "Mode") {
    config.mode = item === "List" ? "list" : "spider";
  }
  if (menu === "Export") {
    const f: Record<string, (r: CrawlResult) => boolean> = {
      "Internal HTML": (r) => (r.resourceType || "HTML") === "HTML",
      "All Links": () => true, "Response Codes": (r) => r.status >= 400,
      "Page Titles": (r) => !!r.title, Redirects: (r) => r.status >= 300 && r.status < 400,
    };
    await exportFilteredCsv(results.value, f[item] ?? (() => true), item.toLowerCase().replace(/\s+/g, "-"));
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
  <div class="app" @click="showModeMenu = false">
    <MenuBar @action="handleMenuAction" />

    <!-- ── Telemetry bar ── -->
    <header class="telemetry-bar">
      <!-- Logo + Mode switcher -->
      <div class="telem-logo" @click.stop="showModeMenu = !showModeMenu">
        <img src="/logo.svg" alt="Fera" class="logo-img" />
        <div class="logo-label">
          <span class="logo-name">Fera</span>
          <span class="logo-mode">{{ modeLabel }} <span class="mode-chevron">&#x25BE;</span></span>
        </div>
        <div v-if="showModeMenu" class="mode-dropdown">
          <button class="mode-item" :class="{ 'mode-item--active': activeMode === 'crawler' }" @click.stop="selectMode('crawler')">Crawler Mode</button>
          <button class="mode-item" :class="{ 'mode-item--active': activeMode === 'settings-finder' }" @click.stop="selectMode('settings-finder')">Settings Finder</button>
        </div>
      </div>

      <template v-if="activeMode === 'crawler'">
        <div class="telem-divider"></div>

        <!-- Status -->
        <div class="telem-stat">
          <span class="telem-label">STATUS</span>
          <span class="telem-value" :class="{ 'val-active': crawling, 'val-stopped': stopped, 'val-done': !crawling && !stopped && results.length }">
            <span class="status-dot"></span>
            {{ statusText }}
          </span>
        </div>

        <!-- URL input (compact) -->
        <div class="telem-url-group">
          <div class="telem-url-wrap">
            <div v-if="config.mode === 'list'" class="telem-list-badge" @click="configSection = 'settings'">
              LIST MODE — {{ config.urls.length }} URL{{ config.urls.length !== 1 ? 's' : '' }}
            </div>
            <input
              v-else
              v-model="url"
              type="url"
              placeholder="https://example.com/"
              class="telem-url"
              :disabled="crawling"
              @keyup.enter="handleStart"
            />
          </div>
        </div>

        <!-- Scope -->
        <div class="telem-stat">
          <span class="telem-label">SCOPE</span>
          <select v-model="crawlScope" class="scope-select" :disabled="crawling">
            <option>Subdomain</option>
            <option>Subfolder</option>
            <option>Exact URL</option>
          </select>
        </div>

        <!-- URLs Found -->
        <div class="telem-stat">
          <span class="telem-label">URLS FOUND</span>
          <span class="telem-value telem-number">{{ results.length }}</span>
        </div>

        <div class="telem-divider"></div>

        <!-- Actions -->
        <div class="telem-actions">
          <button class="btn-pill btn-go" :class="{ 'btn-resume': stopped }" :disabled="!canStart()" @click="handleStart">
            {{ stopped ? '&#x25B6; RESUME' : '&#x25B6; START' }}
          </button>
          <button v-if="crawling" class="btn-pill btn-stop" @click="stopCrawl">
            &#x25A0; PAUSE
          </button>
          <button class="btn-pill btn-reset" @click="handleClear">CLEAR</button>
          <button
            class="btn-pill btn-signin"
            :disabled="crawling || (!browserOpen && !url.trim())"
            @click="browserOpen ? closeBrowser() : openBrowser(normalizeUrl(url))"
          >
            {{ browserOpen ? '&#x2715; CLOSE' : '&#x1F511; SIGN IN' }}
          </button>
          <button
            class="btn-pill btn-headless"
            :class="{ 'btn-headless--off': !config.headless }"
            :disabled="crawling"
            @click="config.headless = !config.headless"
          >
            {{ config.headless ? '&#x1F441; HEADLESS' : '&#x1F5A5; HEADED' }}
          </button>
          <button
            class="btn-pill btn-ogimage"
            :class="{ 'btn-ogimage--on': config.downloadOgImage }"
            :disabled="crawling"
            @click="config.downloadOgImage = !config.downloadOgImage"
          >
            {{ config.downloadOgImage ? '&#x2713; OG:IMAGE' : 'OG:IMAGE' }}
          </button>
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
            @click="handleResumeRecrawl"
          >
            &#x21BB; RESUME RECRAWL ({{ config.recrawlQueue.length }})
          </button>
          <button class="btn-pill btn-debug" @click="showDebugPanel = true" title="Cmd/Ctrl+Shift+D">
            &#x1F527; DEBUG
          </button>
        </div>

        <!-- Config indicators -->
        <div class="telem-divider"></div>
        <div class="config-badges">
          <span v-if="config.userAgent" class="config-badge" title="Custom User-Agent set">UA</span>
          <span v-if="config.delay > 0" class="config-badge" :title="'Delay: ' + config.delay + 'ms'">{{ config.delay }}ms</span>
          <span v-if="!config.respectRobots" class="config-badge config-badge--warn" title="Ignoring robots.txt">NO ROBOTS</span>
          <span v-if="config.scraperRules.length > 0" class="config-badge" :title="config.scraperRules.length + ' scraper rule(s)'">SCRAPER</span>
          <span v-if="Object.keys(config.customHeaders).length > 0" class="config-badge" :title="Object.keys(config.customHeaders).length + ' custom header(s)'">HEADERS</span>
        </div>
      </template>
    </header>

    <!-- ── Crawler Mode ── -->
    <template v-if="activeMode === 'crawler'">
      <CategoryTabs :active="activeCategory" :recrawl-count="config.recrawlQueue.length" @select="activeCategory = $event" />
      <FilterBar
        :total-results="results.length"
        :filtered-count="filteredCount"
        :active-tab="activeCategory"
        :results="results"
        @search="searchQuery = $event"
        @filter-type="filterType = $event"
        @export="exportCsv(results)"
        @select-all="selectAllTrigger++"
      />

      <div class="main-content">
        <div class="left-panels">
          <div class="grid-area">
            <CrawlGrid :results="results" :active-tab="activeCategory" :filter-type="filterType" :select-all="selectAllTrigger" :recrawl-queue-all="recrawlQueueAll" @row-select="onRowSelect" @recrawl="handleRecrawl" @filtered-count="filteredCount = $event" />
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
          <RightSidebar :results="results" />
        </div>
      </div>
    </template>

    <!-- ── Settings Finder Mode ── -->
    <div v-if="activeMode === 'settings-finder'" class="main-content">
      <SettingsFinder />
    </div>

    <ConfigModal v-if="configSection" @close="configSection = null" />
    <ScraperModal v-if="scraperOpen" @close="scraperOpen = false" />
    <ReportPanel v-if="activeReport" :report="activeReport" :results="results" @close="activeReport = null" />
    <AboutModal v-if="showAbout" @close="showAbout = false" />
    <CrawlManager
      v-if="showCrawlManager"
      @close="showCrawlManager = false"
      @load="handleLoadSession"
    />
    <ProfileViewer v-if="showProfile && profileData" :data="profileData" @close="showProfile = false" />
    <SettingsPanel v-if="showSettingsPanel" @close="showSettingsPanel = false" />
    <DebugPanel v-if="showDebugPanel" @close="showDebugPanel = false" />

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

/* ── Telemetry bar ── */
.telemetry-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 16px;
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
.mode-chevron { font-size: 8px; margin-left: 2px; }

.mode-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 6px;
  background: #141a2e;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  padding: 4px;
  z-index: 100;
  min-width: 180px;
}
.mode-item {
  display: block;
  width: 100%;
  padding: 7px 14px;
  border: none;
  background: transparent;
  color: rgba(255,255,255,0.6);
  font-size: 11px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  border-radius: 5px;
  transition: all 0.15s;
}
.mode-item:hover {
  background: rgba(86,156,214,0.15);
  color: #ffffff;
}
.mode-item--active {
  color: #569cd6;
  font-weight: 600;
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

/* URL input — compact 1/3 width */
.telem-url-group {
  flex: 0 1 320px;
  min-width: 180px;
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
  padding: 6px 16px;
  border: none;
  background: transparent;
  color: #ffffff;
  font-size: 11px;
  font-family: 'Ubuntu Mono', monospace;
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

/* Scope select — custom styled, appearance:none */
.scope-select {
  padding: 6px 28px 6px 12px;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 14px;
  background: rgba(255,255,255,0.04) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='rgba(255,255,255,0.4)'/%3E%3C/svg%3E") no-repeat right 10px center;
  color: #ffffff;
  font-family: 'Ubuntu', sans-serif;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  cursor: pointer;
  outline: none;
  appearance: none;
  -webkit-appearance: none;
  transition: border-color 0.15s;
}

.scope-select:focus {
  border-color: rgba(86,156,214,0.5);
  box-shadow: 0 0 0 2px rgba(86,156,214,0.1);
}

.scope-select option {
  background: #141a2e;
  color: #ffffff;
  font-size: 11px;
  padding: 8px;
}

/* Action buttons — rounded pill style */
.telem-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
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

.btn-signin {
  color: #dcdcaa;
  border-color: rgba(220,220,170,0.3);
}
.btn-signin:hover:not(:disabled) {
  background: rgba(220,220,170,0.1);
  border-color: #dcdcaa;
  box-shadow: 0 0 16px rgba(220,220,170,0.15);
}
.btn-signin:disabled {
  opacity: 0.25;
  cursor: default;
}

.btn-headless {
  color: rgba(255,255,255,0.4);
  border-color: rgba(255,255,255,0.1);
}
.btn-headless:hover:not(:disabled) {
  color: rgba(255,255,255,0.7);
  border-color: rgba(255,255,255,0.25);
}
.btn-headless--off {
  color: #ce9178;
  border-color: rgba(206,145,120,0.3);
}
.btn-headless--off:hover:not(:disabled) {
  background: rgba(206,145,120,0.1);
  border-color: #ce9178;
  box-shadow: 0 0 16px rgba(206,145,120,0.15);
}
.btn-headless:disabled {
  opacity: 0.25;
  cursor: default;
}

.btn-ogimage {
  color: rgba(255,255,255,0.4);
  border-color: rgba(255,255,255,0.1);
}
.btn-ogimage:hover:not(:disabled) {
  color: rgba(255,255,255,0.7);
  border-color: rgba(255,255,255,0.25);
}
.btn-ogimage--on {
  color: #c586c0;
  border-color: rgba(197,134,192,0.3);
}
.btn-ogimage--on:hover:not(:disabled) {
  background: rgba(197,134,192,0.1);
  border-color: #c586c0;
  box-shadow: 0 0 16px rgba(197,134,192,0.15);
}
.btn-ogimage:disabled {
  opacity: 0.25;
  cursor: default;
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

.btn-debug {
  color: rgba(255,255,255,0.5);
  border-color: rgba(255,255,255,0.12);
}
.btn-debug:hover {
  color: #569cd6;
  border-color: rgba(86,156,214,0.4);
  background: rgba(86,156,214,0.08);
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

.config-badge--warn {
  color: #dcdcaa;
  border-color: rgba(220,220,170,0.25);
  background: rgba(220,220,170,0.06);
}
</style>
