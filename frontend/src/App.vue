<script setup lang="ts">
import { ref } from "vue";
import CrawlGrid from "./components/CrawlGrid.vue";
import { useCrawl } from "./composables/useCrawl";

const url = ref("");
const maxRequests = ref(100);
const concurrency = ref(5);

const { results, crawling, startCrawl, stopCrawl } = useCrawl();

function handleStart() {
  if (!url.value.trim()) return;
  startCrawl(url.value.trim(), maxRequests.value, concurrency.value);
}
</script>

<template>
  <div class="app">
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
          <input v-model.number="maxRequests" type="number" min="1" max="10000" :disabled="crawling" />
        </label>
        <label class="option">
          Concurrency
          <input v-model.number="concurrency" type="number" min="1" max="20" :disabled="crawling" />
        </label>
        <button v-if="!crawling" class="btn btn-start" @click="handleStart">Start Crawl</button>
        <button v-else class="btn btn-stop" @click="stopCrawl">Stop</button>
      </div>
    </header>
    <main class="grid-container">
      <CrawlGrid :results="results" />
    </main>
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
