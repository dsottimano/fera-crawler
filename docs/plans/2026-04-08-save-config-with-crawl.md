# Save Config With Crawl — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist the full CrawlConfig alongside every saved crawl (DB sessions + .fera files), auto-restore it on load, and show active non-default settings as badges in the telemetry bar.

**Architecture:** Add a `config_json TEXT` column to `crawl_sessions` (migration v4). Serialize the full `CrawlConfig` into it at session creation. On load, deserialize and apply to the reactive config singleton. Same approach for `.fera` file format. Add compact badge indicators in the telemetry bar (top-right area, after action buttons).

**Tech Stack:** SQLite (tauri-plugin-sql), Vue 3 reactive state, existing CrawlConfig type

---

### Task 1: DB Migration — add config_json column

**Files:**
- Modify: `src-tauri/src/lib.rs:66` (add migration v4 after existing v3)

**Step 1: Add migration v4**

After the existing v3 migration block (line ~65), add:

```rust
Migration {
    version: 4,
    description: "add config_json to crawl_sessions",
    sql: "ALTER TABLE crawl_sessions ADD COLUMN config_json TEXT DEFAULT '{}';",
    kind: MigrationKind::Up,
},
```

**Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`

**Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: add config_json column to crawl_sessions (migration v4)"
```

---

### Task 2: useDatabase — save and load config

**Files:**
- Modify: `frontend/src/composables/useDatabase.ts`

**Step 1: Update CrawlSession interface**

Add `config_json` field:

```typescript
export interface CrawlSession {
  id: number;
  start_url: string;
  started_at: string;
  completed_at: string | null;
  result_count?: number;
  config_json?: string;
}
```

**Step 2: Update createSession to accept config**

```typescript
async function createSession(startUrl: string, config?: CrawlConfig): Promise<number> {
  const d = await getDb();
  const configJson = config ? JSON.stringify(config) : "{}";
  const res = await d.execute(
    "INSERT INTO crawl_sessions (start_url, config_json) VALUES ($1, $2)",
    [startUrl, configJson]
  );
  return res.lastInsertId ?? 0;
}
```

Add `CrawlConfig` import at top:

```typescript
import type { CrawlResult, CrawlConfig } from "../types/crawl";
```

**Step 3: Update listSessions to include config_json**

```typescript
async function listSessions(): Promise<CrawlSession[]> {
  const d = await getDb();
  return d.select<CrawlSession[]>(
    `SELECT s.id, s.start_url, s.started_at, s.completed_at, s.config_json,
            COUNT(r.id) as result_count
     FROM crawl_sessions s
     LEFT JOIN crawl_results r ON r.session_id = s.id
     GROUP BY s.id
     ORDER BY s.started_at DESC
     LIMIT 50`
  );
}
```

**Step 4: Add loadSessionConfig function**

```typescript
async function loadSessionConfig(sessionId: number): Promise<CrawlConfig | null> {
  const d = await getDb();
  const rows = await d.select<{ config_json: string }[]>(
    "SELECT config_json FROM crawl_sessions WHERE id = $1",
    [sessionId]
  );
  if (!rows.length || !rows[0].config_json) return null;
  try {
    return JSON.parse(rows[0].config_json);
  } catch {
    return null;
  }
}
```

Add `loadSessionConfig` to the return object.

**Step 5: Commit**

```bash
git add frontend/src/composables/useDatabase.ts
git commit -m "feat: save and load CrawlConfig in crawl_sessions"
```

---

### Task 3: useConfig — add applyConfig method

**Files:**
- Modify: `frontend/src/composables/useConfig.ts`

**Step 1: Add applyConfig function**

```typescript
function applyConfig(incoming: Partial<CrawlConfig>) {
  Object.assign(config, { ...defaultConfig, ...incoming });
}
```

Import `defaultConfig` (already imported on line 2).

Add `applyConfig` to the return object:

```typescript
return { config, reset, saveDefaults, applyConfig };
```

**Step 2: Commit**

```bash
git add frontend/src/composables/useConfig.ts
git commit -m "feat: add applyConfig to useConfig composable"
```

---

### Task 4: useCrawl — pass config to createSession, restore on load

**Files:**
- Modify: `frontend/src/composables/useCrawl.ts`

**Step 1: Update createSession call in startCrawl**

In `startCrawl`, change the session creation (around line 60):

```typescript
sessionId = await createSession(url, config);
```

**Step 2: Update loadSession to return config**

Import `loadSessionConfig` from useDatabase. Update `loadSession`:

```typescript
async function loadSession(sessionId: number): Promise<CrawlConfig | null> {
  const loaded = await loadSessionResults(sessionId);
  results.value = loaded;
  currentSessionId.value = sessionId;
  const savedConfig = await loadSessionConfig(sessionId);
  return savedConfig;
}
```

Update the destructured imports from useDatabase:

```typescript
const {
  createSession,
  completeSession,
  insertResult,
  loadSessionResults,
  loadSessionConfig,
} = useDatabase();
```

**Step 3: Commit**

```bash
git add frontend/src/composables/useCrawl.ts
git commit -m "feat: pass config to createSession, return config on loadSession"
```

---

### Task 5: useFileOps — include config in .fera files

**Files:**
- Modify: `frontend/src/composables/useFileOps.ts`

**Step 1: Update saveCrawl to accept and save config**

```typescript
import type { CrawlResult, CrawlConfig } from "../types/crawl";

// ...

async function saveCrawl(results: CrawlResult[], config?: CrawlConfig): Promise<boolean> {
  const home = await homeDir();
  const path = await save({
    title: "Save Crawl",
    defaultPath: home + "/crawl.fera",
    filters: [{ name: "Fera Crawl", extensions: ["fera"] }],
  });
  if (!path) return false;
  await writeTextFile(path, JSON.stringify({ version: 2, config: config ?? {}, results }, null, 2));
  return true;
}
```

**Step 2: Update openCrawl to return config**

```typescript
async function openCrawl(): Promise<{ results: CrawlResult[]; config?: CrawlConfig } | null> {
  const home = await homeDir();
  const path = await open({
    title: "Open Crawl",
    defaultPath: home,
    filters: [{ name: "Fera Crawl", extensions: ["fera"] }],
    multiple: false,
    directory: false,
  });
  if (!path) return null;
  try {
    const text = await readTextFile(path as string);
    const data = JSON.parse(text);
    return { results: data.results ?? [], config: data.config };
  } catch (e) {
    console.error("Failed to open crawl file:", e);
    return null;
  }
}
```

**Step 3: Commit**

```bash
git add frontend/src/composables/useFileOps.ts
git commit -m "feat: include CrawlConfig in .fera file save/load"
```

---

### Task 6: App.vue — wire up config restore on load + config badges

**Files:**
- Modify: `frontend/src/App.vue`

**Step 1: Update imports**

Add `applyConfig` to the useConfig destructure:

```typescript
const { config, applyConfig } = useConfig();
```

**Step 2: Update handleOpen in CrawlManager load handler**

Change `handleLoadSession`:

```typescript
async function handleLoadSession(sessionUrl: string, savedConfig?: CrawlConfig) {
  url.value = sessionUrl;
  if (savedConfig) applyConfig(savedConfig);
  showCrawlManager.value = false;
}
```

Update the CrawlManager component usage to pass config. The `@load` event needs to carry config. We'll update CrawlManager to emit it (Task 7).

**Step 3: Update File > Open handler**

In `handleMenuAction`, update the "Open..." case:

```typescript
else if (item === "Open...") {
  const data = await openCrawl();
  if (data) {
    setResults(data.results);
    if (data.config) applyConfig(data.config);
  }
}
```

**Step 4: Update File > Save As handler**

```typescript
else if (item === "Save As...") { await saveCrawl(results.value, config); }
```

Also update the "Save & Clear" handler:

```typescript
async function handleSaveAndClear() {
  const saved = await saveCrawl(results.value, config);
  if (!saved) return;
  showClearConfirm.value = false;
  doClear();
}
```

**Step 5: Add config badge indicators in telemetry bar**

After the existing action buttons div (`.telem-actions`), add a config summary section:

```html
<!-- Config indicators -->
<div class="telem-divider"></div>
<div class="config-badges">
  <span v-if="config.userAgent" class="config-badge" title="Custom User-Agent set">UA</span>
  <span v-if="config.delay > 0" class="config-badge" :title="'Delay: ' + config.delay + 'ms'">{{ config.delay }}ms</span>
  <span v-if="!config.respectRobots" class="config-badge config-badge--warn" title="Ignoring robots.txt">NO ROBOTS</span>
  <span v-if="config.scraperRules.length > 0" class="config-badge" :title="config.scraperRules.length + ' scraper rule(s)'">SCRAPER</span>
  <span v-if="config.mode === 'list'" class="config-badge" title="List mode">LIST</span>
  <span v-if="Object.keys(config.customHeaders).length > 0" class="config-badge" :title="Object.keys(config.customHeaders).length + ' custom header(s)'">HEADERS</span>
</div>
```

Place this inside the `<template v-if="activeMode === 'crawler'">` block, after the `.telem-actions` div.

**Step 6: Add CSS for config badges**

```css
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
```

**Step 7: Commit**

```bash
git add frontend/src/App.vue
git commit -m "feat: restore config on crawl load, add config badge indicators"
```

---

### Task 7: CrawlManager — emit config on load

**Files:**
- Modify: `frontend/src/components/CrawlManager.vue`

**Step 1: Update emit types and imports**

```typescript
import type { CrawlConfig } from "../types/crawl";
import { useConfig } from "../composables/useConfig";

const emit = defineEmits<{
  close: [];
  load: [startUrl: string, config?: CrawlConfig];
}>();
```

Add `applyConfig` from useConfig:

```typescript
const { applyConfig } = useConfig();
```

**Step 2: Update handleOpen to load and apply config**

```typescript
async function handleOpen(session: CrawlSession) {
  openingId.value = session.id;
  try {
    const savedConfig = await loadSession(session.id);
    if (savedConfig) applyConfig(savedConfig);
    emit("load", session.start_url, savedConfig ?? undefined);
  } catch (e) {
    console.error("Failed to load session:", e);
    openingId.value = null;
  }
}
```

Import `loadSessionConfig` isn't needed here since `loadSession` now returns the config.

**Step 3: Show config summary in info panel**

Add after the existing info rows:

```html
<template v-if="s.config_json && s.config_json !== '{}'">
  <div class="info-row"><span class="info-label">MODE</span><span class="info-value">{{ parseConfig(s.config_json).mode ?? 'spider' }}</span></div>
  <div class="info-row"><span class="info-label">HEADLESS</span><span class="info-value">{{ parseConfig(s.config_json).headless !== false ? 'Yes' : 'No' }}</span></div>
  <div v-if="parseConfig(s.config_json).userAgent" class="info-row"><span class="info-label">USER AGENT</span><span class="info-value info-mono">{{ parseConfig(s.config_json).userAgent }}</span></div>
  <div v-if="parseConfig(s.config_json).delay" class="info-row"><span class="info-label">DELAY</span><span class="info-value">{{ parseConfig(s.config_json).delay }}ms</span></div>
  <div v-if="parseConfig(s.config_json).downloadOgImage" class="info-row"><span class="info-label">OG:IMAGE</span><span class="info-value">Downloading</span></div>
  <div v-if="(parseConfig(s.config_json).scraperRules ?? []).length > 0" class="info-row"><span class="info-label">SCRAPER</span><span class="info-value">{{ parseConfig(s.config_json).scraperRules.length }} rule(s)</span></div>
</template>
```

Add the `parseConfig` helper:

```typescript
function parseConfig(json: string): Partial<CrawlConfig> {
  try { return JSON.parse(json); }
  catch { return {}; }
}
```

**Step 4: Commit**

```bash
git add frontend/src/components/CrawlManager.vue
git commit -m "feat: show config details in saved crawls, emit config on load"
```

---

### Task 8: Update App.vue CrawlManager @load handler

**Files:**
- Modify: `frontend/src/App.vue`

**Step 1: Update handleLoadSession and CrawlManager template**

The `@load` handler in the template already calls `handleLoadSession`. Update to match the new signature. The CrawlManager template binding:

```html
<CrawlManager
  v-if="showCrawlManager"
  @close="showCrawlManager = false"
  @load="handleLoadSession"
/>
```

This already works since `handleLoadSession` was updated in Task 6 Step 2 to accept optional config.

But the `@load` emit from CrawlManager now passes two args. Vue will call `handleLoadSession(startUrl, config)` automatically.

**Step 2: Verify type-check passes**

Run: `cd frontend && npx tsc --noEmit`

**Step 3: Commit (if any changes needed)**

---

### Verification

After all tasks:

1. `cd src-tauri && cargo check` — Rust compiles
2. `cd frontend && npx tsc --noEmit` — TypeScript passes  
3. `npm run dev` — app launches
4. Start a crawl with custom settings (headed, custom UA, delay, scraper rules)
5. Verify config badges appear in telemetry bar
6. File > Save As — save the crawl
7. Clear, then File > Open — config restores, badges reappear
8. File > Saved Crawls — info panel shows config details
9. Open from Saved Crawls — config restores
