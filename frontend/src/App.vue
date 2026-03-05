<script setup lang="ts">
import { ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import MenuBar from "./components/MenuBar.vue";
import CrawlGrid from "./components/CrawlGrid.vue";
import ConfigModal from "./components/ConfigModal.vue";
import ReportPanel from "./components/ReportPanel.vue";
import AboutModal from "./components/AboutModal.vue";
import { useCrawl } from "./composables/useCrawl";
import { useConfig } from "./composables/useConfig";
import { useFileOps } from "./composables/useFileOps";
import type { CrawlResult } from "./types/crawl";

const url = ref("");
const { config } = useConfig();
const { results, crawling, startCrawl, stopCrawl, clearResults, setResults } = useCrawl();
const { saveCrawl, openCrawl, exportCsv, exportFilteredCsv } = useFileOps();

// Modal state
const configSection = ref<string | null>(null);
const activeReport = ref<string | null>(null);
const showAbout = ref(false);

function handleStart() {
  if (!url.value.trim()) return;
  startCrawl(url.value.trim(), config);
}

async function handleMenuAction(menu: string, item: string) {
  // File menu
  if (menu === "File") {
    if (item === "New Crawl") {
      clearResults();
      url.value = "";
    } else if (item === "Open...") {
      const data = await openCrawl();
      if (data) setResults(data);
    } else if (item === "Save") {
      await saveCrawl(results.value);
    } else if (item === "Export CSV") {
      await exportCsv(results.value);
    } else if (item === "Export Excel") {
      // Export as TSV (opens in Excel) — avoids needing xlsx dependency
      await exportFilteredCsv(results.value, () => true, "crawl-export");
    } else if (item === "Exit") {
      await getCurrentWindow().close();
    }
  }

  // Configuration menu
  if (menu === "Configuration") {
    const sectionMap: Record<string, string> = {
      Spider: "spider",
      "Robots.txt": "robots",
      Speed: "speed",
      "User-Agent": "useragent",
      "Custom Headers": "headers",
    };
    configSection.value = sectionMap[item] ?? null;
  }

  // Mode menu
  if (menu === "Mode") {
    config.mode = item === "List" ? "list" : "spider";
    if (item === "List") {
      configSection.value = "spider"; // open spider config to show URL list input
    }
  }

  // Export menu (filtered exports)
  if (menu === "Export") {
    const filters: Record<string, (r: CrawlResult) => boolean> = {
      "Internal HTML": (r) => (r.resourceType || "HTML") === "HTML",
      "All Links": () => true,
      "Response Codes": (r) => r.status >= 400,
      "Page Titles": (r) => !!r.title,
      Redirects: (r) => r.status >= 300 && r.status < 400,
    };
    await exportFilteredCsv(results.value, filters[item] ?? (() => true), item.toLowerCase().replace(/\s+/g, "-"));
  }

  // Reports menu
  if (menu === "Reports") {
    const reportMap: Record<string, string> = {
      "Crawl Overview": "overview",
      "Redirect Chains": "redirects",
      "Duplicate Content": "duplicates",
      "Orphan Pages": "orphans",
    };
    activeReport.value = reportMap[item] ?? null;
  }

  // Help menu
  if (menu === "Help") {
    if (item === "About Fera") {
      showAbout.value = true;
    } else if (item === "Documentation") {
      // Open docs in browser
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl("https://github.com/dsottimano/fera-crawler");
    }
  }
}
</script>

<template>
  <div class="app">
    <MenuBar @action="handleMenuAction" />
    <header class="toolbar">
      <h1 class="logo">Fera</h1>
      <div class="controls">
        <input
          v-model="url"
          type="url"
          placeholder="https://example.com"
          class="url-input"
          :disabled="crawling"
          @keyup.enter="handleStart"
        />
        <label class="option">
          Max
          <input v-model.number="config.maxRequests" type="number" min="1" max="10000" :disabled="crawling" />
        </label>
        <label class="option">
          Concurrency
          <input v-model.number="config.concurrency" type="number" min="1" max="20" :disabled="crawling" />
        </label>
        <span v-if="config.mode === 'list'" class="mode-badge">LIST</span>
        <button v-if="!crawling" class="btn btn-start" @click="handleStart">Start Crawl</button>
        <button v-else class="btn btn-stop" @click="stopCrawl">Stop</button>
      </div>
    </header>
    <main class="grid-container">
      <CrawlGrid :results="results" />
    </main>

    <!-- Modals -->
    <ConfigModal v-if="configSection" :section="configSection" @close="configSection = null" />
    <ReportPanel v-if="activeReport" :report="activeReport" :results="results" @close="activeReport = null" />
    <AboutModal v-if="showAbout" @close="showAbout = false" />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 16px;
  background: #16213e;
  border-bottom: 1px solid #0f3460;
}

.logo {
  font-size: 1.4rem;
  font-weight: 700;
  color: #e94560;
  min-width: fit-content;
}

.controls {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
}

.url-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid #0f3460;
  border-radius: 6px;
  background: #1a1a2e;
  color: #e0e0e0;
  font-size: 0.9rem;
}

.option {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.8rem;
  color: #a0a0a0;
}

.option input {
  width: 60px;
  padding: 6px 8px;
  border: 1px solid #0f3460;
  border-radius: 4px;
  background: #1a1a2e;
  color: #e0e0e0;
  font-size: 0.85rem;
}

.mode-badge {
  padding: 4px 10px;
  background: #e94560;
  color: white;
  font-size: 0.7rem;
  font-weight: 700;
  border-radius: 4px;
  letter-spacing: 0.5px;
}

.btn {
  padding: 8px 20px;
  border: none;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
  font-size: 0.9rem;
}

.btn-start {
  background: #e94560;
  color: white;
}

.btn-stop {
  background: #ff6b35;
  color: white;
}

.grid-container {
  flex: 1;
  overflow: hidden;
}
</style>
