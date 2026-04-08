# Recrawl Queue Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist the recrawl queue alongside crawl sessions so users can stop, close the app, and resume recrawling later — with a dedicated tab showing queue status (done/pending/error).

**Architecture:** Add `recrawlQueue: string[]` to CrawlConfig (persisted in `config_json`). Track completion status in memory during crawl. New "Recrawl Queue" category tab shows all queued URLs with status badges. On resume, only recrawl URLs still pending.

**Tech Stack:** Vue 3 reactive state, SQLite (existing config_json column), Tabulator grid (existing)

---

### Task 1: Add recrawlQueue to CrawlConfig

**Files:**
- Modify: `frontend/src/types/crawl.ts`

**Step 1: Add field to CrawlConfig interface**

```typescript
// In CrawlConfig interface, after scraperUrl:
recrawlQueue: string[];
```

**Step 2: Add default to defaultConfig**

```typescript
// In defaultConfig, after scraperUrl:
recrawlQueue: [],
```

**Step 3: Commit**

```bash
git add frontend/src/types/crawl.ts
git commit -m "feat: add recrawlQueue to CrawlConfig"
```

---

### Task 2: Persist queue on recrawl start and remove completed URLs

**Files:**
- Modify: `frontend/src/App.vue` (handleRecrawl)
- Modify: `frontend/src/composables/useCrawl.ts` (startCrawl, result listener)

**Step 1: Store queue in config when recrawl starts**

In `App.vue`, update `handleRecrawl`:

```typescript
async function handleRecrawl(urls: string[]) {
  if (!urls.length || crawling.value) return;
  // Persist the full queue in config so it survives stop/restart
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
```

**Step 2: Remove URLs from queue as results arrive**

In `useCrawl.ts`, the `crawl-result` listener should remove completed URLs from the config's recrawlQueue. Import useConfig:

```typescript
import { useConfig } from "./useConfig";
```

At the top of `startCrawl`, get config ref:

```typescript
const { config: appConfig } = useConfig();
```

In the `crawl-result` listener, after the result is pushed/replaced:

```typescript
// Remove from recrawl queue if present
const queueIdx = appConfig.recrawlQueue.indexOf(event.payload.url);
if (queueIdx >= 0) {
  appConfig.recrawlQueue.splice(queueIdx, 1);
}
```

**Step 3: Save updated config to DB on stop**

In `stopCrawl`, save the current config (with reduced queue) to DB:

```typescript
async function stopCrawl() {
  try {
    await invoke("stop_crawl");
  } catch (e) {
    console.error("Stop failed:", e);
  }
  // Save current config (with updated recrawl queue) to DB
  if (currentSessionId.value) {
    const { config: appConfig } = useConfig();
    try {
      await updateSessionConfig(currentSessionId.value, appConfig);
    } catch (e) {
      console.error("Config save on stop failed:", e);
    }
  }
  crawling.value = false;
  stopped.value = true;
  cleanup();
}
```

Also save on `crawl-complete` (queue should be empty by then, clearing it):

In the `crawl-complete` listener, after `completeSession`, add:

```typescript
// Clear recrawl queue — all done
const { config: appConfig } = useConfig();
if (appConfig.recrawlQueue.length > 0) {
  appConfig.recrawlQueue = [];
}
```

**Step 4: Commit**

```bash
git add frontend/src/App.vue frontend/src/composables/useCrawl.ts
git commit -m "feat: persist recrawl queue, remove URLs as they complete"
```

---

### Task 3: Resume recrawl from saved queue

**Files:**
- Modify: `frontend/src/App.vue`

**Step 1: Add resume-recrawl logic**

When a session is loaded with a non-empty `recrawlQueue`, the user should be able to resume. Add a computed and handler:

```typescript
const hasRecrawlQueue = computed(() => config.recrawlQueue.length > 0);

function handleResumeRecrawl() {
  if (!config.recrawlQueue.length || crawling.value) return;
  handleRecrawl([...config.recrawlQueue]);
}
```

**Step 2: Show resume button when queue exists**

In the telemetry bar actions, add a resume-recrawl button:

```html
<button
  v-if="hasRecrawlQueue && !crawling"
  class="btn-pill btn-recrawl"
  @click="handleResumeRecrawl"
>
  &#x21BB; RESUME RECRAWL ({{ config.recrawlQueue.length }})
</button>
```

**Step 3: Add CSS**

```css
.btn-recrawl {
  color: #ce9178;
  border-color: rgba(206,145,120,0.3);
}
.btn-recrawl:hover {
  background: rgba(206,145,120,0.1);
  border-color: #ce9178;
  box-shadow: 0 0 16px rgba(206,145,120,0.15);
}
```

**Step 4: Commit**

```bash
git add frontend/src/App.vue
git commit -m "feat: resume recrawl button when queue exists"
```

---

### Task 4: Recrawl Queue category tab

**Files:**
- Modify: `frontend/src/components/CategoryTabs.vue`
- Modify: `frontend/src/components/CrawlGrid.vue`

**Step 1: Add tab to CategoryTabs**

In `CategoryTabs.vue`, add "Recrawl Queue" to the tabs array:

```typescript
const tabs = [
  "Internal", "External", "Security", "Response Codes", "URL",
  "Page Titles", "Meta Description", "H1", "H2", "Content",
  "Images", "Canonicals", "Directives", "JavaScript", "Links",
  "Structured Data", "Overview", "Issues", "Site Structure", "Response Times",
  "Recrawl Queue",
];
```

**Step 2: Add column mapping for Recrawl Queue**

In `CrawlGrid.vue`, add a new column for queue status:

```typescript
// Add to COL definitions:
queueStatus: {
  title: "Queue Status", field: "_queueStatus", width: 130, hozAlign: "center",
  mutator: (_value: any, data: any) => {
    if (!config.recrawlQueue.length && !data._wasQueued) return "";
    if (config.recrawlQueue.includes(data.url)) return "Pending";
    if (data.status === 0 && data.error) return "Error";
    if (data.status >= 400) return "Error";
    return "Done";
  },
  formatter: (cell: any) => {
    const val = cell.getValue();
    if (val === "Done") return '<span style="color:#4ec9b0;font-weight:600">Done</span>';
    if (val === "Pending") return '<span style="color:#dcdcaa;font-weight:600">Pending</span>';
    if (val === "Error") return '<span style="color:#f44747;font-weight:600">Error</span>';
    return "";
  },
},
```

Add the tab-to-columns mapping:

```typescript
"Recrawl Queue": [COL.address, COL.queueStatus, COL.statusCode, COL.statusText, COL.contentType, COL.responseTime, COL.size],
```

**Step 3: Add filter for Recrawl Queue tab**

The Recrawl Queue tab needs to know which URLs were ever in the queue. Since we remove URLs from the queue as they complete, we need a way to show completed ones too.

The approach: CrawlGrid receives the full recrawl queue (original list) as a prop. The tab filters to only show URLs that are in the original queue OR still in the pending queue.

Add a new prop to CrawlGrid:

```typescript
const props = defineProps<{
  results: CrawlResult[];
  activeTab: string;
  filterType: string;
  selectAll: number;
  recrawlQueueAll: string[];  // all URLs ever queued (original list)
}>();
```

Update the filter:

```typescript
case "Recrawl Queue": return (r) => {
  return props.recrawlQueueAll.includes(r.url) || config.recrawlQueue.includes(r.url);
};
```

**Step 4: Pass recrawlQueueAll from App.vue**

In App.vue, track the full original queue:

```typescript
const recrawlQueueAll = ref<string[]>([]);
```

In `handleRecrawl`, save the full list:

```typescript
recrawlQueueAll.value = [...urls];
```

When loading a session with a recrawl queue, also populate this:

In the session load flow (after applyConfig), if config has recrawlQueue:

```typescript
// After applyConfig in handleLoadSession or handleOpen
if (config.recrawlQueue.length > 0) {
  recrawlQueueAll.value = [...config.recrawlQueue];
}
```

Pass to CrawlGrid:

```html
<CrawlGrid :results="results" :active-tab="activeCategory" :filter-type="filterType"
  :select-all="selectAllTrigger" :recrawl-queue-all="recrawlQueueAll"
  @row-select="onRowSelect" @recrawl="handleRecrawl" @filtered-count="filteredCount = $event" />
```

**Step 5: Commit**

```bash
git add frontend/src/components/CategoryTabs.vue frontend/src/components/CrawlGrid.vue frontend/src/App.vue
git commit -m "feat: add Recrawl Queue tab with done/pending/error status"
```

---

### Task 5: Show pending count in Recrawl Queue tab label

**Files:**
- Modify: `frontend/src/components/CategoryTabs.vue`
- Modify: `frontend/src/App.vue`

**Step 1: Pass queue count to CategoryTabs**

Add prop:

```typescript
const props = defineProps<{ active: string; recrawlCount: number }>();
```

Update the tab button to show count:

```html
<button
  v-for="tab in tabs"
  :key="tab"
  class="cat-tab"
  :class="{ 'cat-tab--active': active === tab }"
  @click="emit('select', tab)"
>
  {{ tab }}
  <span v-if="tab === 'Recrawl Queue' && recrawlCount > 0" class="queue-count">{{ recrawlCount }}</span>
</button>
```

**Step 2: Add CSS for count badge**

```css
.queue-count {
  margin-left: 4px;
  padding: 1px 6px;
  border-radius: 14px;
  font-size: 8px;
  font-weight: 700;
  background: rgba(206,145,120,0.15);
  color: #ce9178;
}
```

**Step 3: Pass from App.vue**

```html
<CategoryTabs :active="activeCategory" :recrawl-count="config.recrawlQueue.length" @select="activeCategory = $event" />
```

**Step 4: Commit**

```bash
git add frontend/src/components/CategoryTabs.vue frontend/src/App.vue
git commit -m "feat: show pending count badge on Recrawl Queue tab"
```

---

### Verification

1. `npx tsc --noEmit` — TypeScript passes
2. Start a crawl, select some URLs, hit Recrawl
3. Verify Recrawl Queue tab appears with status indicators
4. Stop mid-recrawl — pending URLs stay in queue
5. Save & reopen — queue persists, Resume Recrawl button shows
6. Resume — only pending URLs get recrawled
7. Complete — queue clears, all show "Done"
