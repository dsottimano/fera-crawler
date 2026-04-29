# Scraper Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a visual element picker that lets users define CSS selectors on a live page, then extract those values + presence checks during crawls as custom columns.

**Architecture:** New `"inspect"` sidecar command opens headed browser with injected inspector JS (hover highlight + click-to-select). Selected elements emit `selector-picked` events via NDJSON→Rust→Vue. Scraper rules stored in config, passed to crawler as `--scraper-rules` JSON arg, evaluated via `page.querySelector()` per page. Results stored in `seo_json`, displayed as dynamic grid columns.

**Tech Stack:** Playwright (page.exposeFunction + page.addStyleTag + page.evaluate), Vue 3 reactive config, Tabulator dynamic columns, existing NDJSON/Tauri event pipeline.

---

## Task 1: Add `scraperRules` to Types and Config

**Files:**
- Modify: `sidecar/src/types.ts:9-61` (CrawlResult) and `63-76` (CrawlConfig)
- Modify: `frontend/src/types/crawl.ts:9-63` (CrawlResult) and `65-89` (CrawlConfig + default)

**Step 1: Add ScraperRule type and scraper field to sidecar types**

In `sidecar/src/types.ts`, add after line 7 (after MetaTag interface):

```typescript
export interface ScraperRule {
  name: string;
  selector: string;
}
```

Add to `CrawlResult` after line 60 (`metaTags: MetaTag[];`):

```typescript
  // Scraper
  scraper: Record<string, { value: string; appears: boolean }>;
```

Add to `CrawlConfig` after line 75 (`downloadOgImage?: boolean;`):

```typescript
  scraperRules?: ScraperRule[];
```

**Step 2: Mirror types in frontend**

In `frontend/src/types/crawl.ts`, add after MetaTag interface:

```typescript
export interface ScraperRule {
  name: string;
  selector: string;
}
```

Add to `CrawlResult` after `metaTags: MetaTag[];`:

```typescript
  // Scraper
  scraper: Record<string, { value: string; appears: boolean }>;
```

Add to `CrawlConfig` interface after `downloadOgImage: boolean;`:

```typescript
  scraperRules: ScraperRule[];
```

Add to `defaultConfig` after `downloadOgImage: false,`:

```typescript
  scraperRules: [],
```

**Step 3: Run type check**

Run: `cd frontend && ../node_modules/.bin/vue-tsc --noEmit`
Expected: Errors in useDatabase.ts (missing `scraper` in mapped results) — that's expected, fixed in Task 5.

Run: `cd sidecar && npx tsc --noEmit`
Expected: Errors in crawler.ts (missing `scraper` in return object) — expected, fixed in Task 3.

**Step 4: Commit**

```bash
git add sidecar/src/types.ts frontend/src/types/crawl.ts
git commit -m "feat(scraper): add ScraperRule type and scraper field to CrawlResult/CrawlConfig"
```

---

## Task 2: Implement Inspector Sidecar Command

**Files:**
- Create: `sidecar/src/inspector.ts`
- Modify: `sidecar/src/index.ts:1-3` (imports), `17-120` (command dispatch)

**Step 1: Create the inspector module**

Create `sidecar/src/inspector.ts`. This module:
- Exports `openInspector(rawUrl: string, profileDir?: string): Promise<void>`
- Launches headed Playwright persistent context (same pattern as `openBrowser` in `crawler.ts:659-711`)
- Injects inspector JS via `page.addScriptTag` after page loads
- Uses `page.exposeFunction("__feraPickSelector", ...)` to bridge clicks back to Node
- On pick, calls `writeLine({ event: "selector-picked", selector, tag, text, dimensions })` via NDJSON

```typescript
import fs from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { writeLine } from "./pipeline.js";

// Reuse helpers from crawler — need to export them first (or duplicate the small ones)
// findChromium, getBrowserProfileDir, ensureProtocol, killChromeForProfile, STEALTH_ARGS
// These are already exported or can be imported from crawler.ts

/**
 * The inspector JS injected into the page.
 * Uses shadow DOM to isolate styles from the host page.
 * Must be a plain string (no TS) to avoid esbuild __name() issues.
 */
const INSPECTOR_SCRIPT = `(() => {
  // Prevent double-injection
  if (window.__feraInspectorActive) return;
  window.__feraInspectorActive = true;

  // Create shadow host for overlay + tooltip (isolated from page styles)
  const host = document.createElement("div");
  host.id = "__fera-inspector-host";
  host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  // Overlay highlight
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;pointer-events:none;background:rgba(86,156,214,0.3);border:2px solid rgba(86,156,214,0.8);border-radius:2px;transition:all 0.05s ease;display:none;z-index:2147483647;";
  shadow.appendChild(overlay);

  // Tooltip
  const tooltip = document.createElement("div");
  tooltip.style.cssText = "position:fixed;pointer-events:none;background:#1e1e2e;color:#fff;font:600 11px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);box-shadow:0 4px 12px rgba(0,0,0,0.4);white-space:nowrap;display:none;z-index:2147483647;max-width:400px;overflow:hidden;text-overflow:ellipsis;";
  shadow.appendChild(tooltip);

  let currentEl = null;

  function getSelector(el) {
    // 1. Try ID
    if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) {
      return "#" + CSS.escape(el.id);
    }

    // 2. Try tag + unique class combo
    var tag = el.tagName.toLowerCase();
    if (el.classList.length > 0) {
      for (var i = 0; i < el.classList.length; i++) {
        var sel = tag + "." + CSS.escape(el.classList[i]);
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
      // Try full class list
      var fullSel = tag + "." + Array.from(el.classList).map(function(c) { return CSS.escape(c); }).join(".");
      if (document.querySelectorAll(fullSel).length === 1) return fullSel;
    }

    // 3. Try tag alone
    if (document.querySelectorAll(tag).length === 1) return tag;

    // 4. Try tag + attribute (common ones)
    var attrs = ["name", "role", "type", "data-testid", "aria-label"];
    for (var j = 0; j < attrs.length; j++) {
      var attrVal = el.getAttribute(attrs[j]);
      if (attrVal) {
        var attrSel = tag + "[" + attrs[j] + '="' + CSS.escape(attrVal) + '"]';
        if (document.querySelectorAll(attrSel).length === 1) return attrSel;
      }
    }

    // 5. Build shortest unique path with nth-child
    var parts = [];
    var current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      var cTag = current.tagName.toLowerCase();
      var parent = current.parentElement;
      if (!parent) break;
      var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === current.tagName; });
      if (siblings.length > 1) {
        var idx = siblings.indexOf(current) + 1;
        parts.unshift(cTag + ":nth-child(" + idx + ")");
      } else {
        parts.unshift(cTag);
      }
      // Check if partial path is already unique
      var partial = parts.join(" > ");
      if (document.querySelectorAll(partial).length === 1) return partial;
      current = parent;
    }
    return parts.join(" > ");
  }

  document.addEventListener("mouseover", function(e) {
    var el = e.target;
    if (!el || el === document.body || el === document.documentElement) {
      overlay.style.display = "none";
      tooltip.style.display = "none";
      currentEl = null;
      return;
    }
    currentEl = el;
    var rect = el.getBoundingClientRect();
    overlay.style.left = rect.left + "px";
    overlay.style.top = rect.top + "px";
    overlay.style.width = rect.width + "px";
    overlay.style.height = rect.height + "px";
    overlay.style.display = "block";

    // Tooltip content: tag.classes — W x H
    var tag = el.tagName.toLowerCase();
    var classes = el.classList.length > 0 ? "." + Array.from(el.classList).join(".") : "";
    var dims = Math.round(rect.width) + " x " + Math.round(rect.height);
    tooltip.textContent = tag + classes + "  " + dims;
    tooltip.style.display = "block";

    // Position tooltip below element, or above if near bottom
    var tTop = rect.bottom + 8;
    if (tTop + 30 > window.innerHeight) tTop = rect.top - 36;
    tooltip.style.top = tTop + "px";
    tooltip.style.left = Math.min(rect.left, window.innerWidth - 350) + "px";
  }, true);

  document.addEventListener("mouseout", function(e) {
    if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
      overlay.style.display = "none";
      tooltip.style.display = "none";
      currentEl = null;
    }
  }, true);

  document.addEventListener("click", function(e) {
    if (!currentEl) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    var el = currentEl;
    var selector = getSelector(el);
    var tag = el.tagName.toLowerCase();
    var text = (el.textContent || "").trim().substring(0, 200);
    var rect = el.getBoundingClientRect();
    var dims = Math.round(rect.width) + " x " + Math.round(rect.height);

    // Flash green on pick
    overlay.style.background = "rgba(78,201,176,0.4)";
    overlay.style.borderColor = "rgba(78,201,176,0.9)";
    setTimeout(function() {
      overlay.style.background = "rgba(86,156,214,0.3)";
      overlay.style.borderColor = "rgba(86,156,214,0.8)";
    }, 300);

    window.__feraPickSelector(selector, tag, text, dims);
  }, true);
})()`;

export async function openInspector(rawUrl: string, profileDir?: string): Promise<void> {
  // Import helpers from crawler (they need to be exported — see step 2)
  const { findChromium, getBrowserProfileDir, ensureProtocol, killChromeForProfile, STEALTH_ARGS } = await import("./crawler.js");

  const url = ensureProtocol(rawUrl);
  const executablePath = findChromium();
  const userDataDir = getBrowserProfileDir(profileDir);

  fs.mkdirSync(userDataDir, { recursive: true });
  await killChromeForProfile(userDataDir);

  writeLine({ event: "browser-opened", url } as any);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath,
    args: [...STEALTH_ARGS, "--start-maximized"],
    ignoreDefaultArgs: ["--enable-automation"],
    viewport: null,
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  // Expose the bridge function BEFORE navigation
  await page.exposeFunction("__feraPickSelector", (selector: string, tag: string, text: string, dimensions: string) => {
    writeLine({ event: "selector-picked", selector, tag, text, dimensions } as any);
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Inject inspector script
  await page.evaluate(INSPECTOR_SCRIPT);

  // Re-inject on navigation (user might click links)
  page.on("domcontentloaded", async () => {
    try {
      await page.evaluate(INSPECTOR_SCRIPT);
    } catch {}
  });

  // Handle new pages opened by the user
  context.on("page", async (newPage: Page) => {
    try {
      await newPage.exposeFunction("__feraPickSelector", (selector: string, tag: string, text: string, dimensions: string) => {
        writeLine({ event: "selector-picked", selector, tag, text, dimensions } as any);
      });
      newPage.on("domcontentloaded", async () => {
        try { await newPage.evaluate(INSPECTOR_SCRIPT); } catch {}
      });
      // Inject immediately if already loaded
      try { await newPage.evaluate(INSPECTOR_SCRIPT); } catch {}
    } catch {}
  });

  // Wait for browser to close
  await new Promise<void>((resolve) => {
    context.on("close", () => resolve());
  });

  writeLine({ event: "browser-closed" } as any);
}
```

**Step 2: Export shared helpers from crawler.ts**

In `sidecar/src/crawler.ts`, the following functions/constants need to be exported (they are currently module-private). Find each and add `export`:

- `STEALTH_ARGS` (const array near top of file — find with `grep -n "STEALTH_ARGS"`)
- `findChromium()` function
- `getBrowserProfileDir()` function
- `ensureProtocol()` function
- `killChromeForProfile()` function

For each, change `function foo(` to `export function foo(` and `const STEALTH_ARGS` to `export const STEALTH_ARGS`.

**Step 3: Add `"inspect"` command to CLI entry point**

In `sidecar/src/index.ts`, add import at line 2:

```typescript
import { runCrawler, openBrowser, dumpProfile } from "./crawler.js";
import { openInspector } from "./inspector.js";
```

Add new command branch after the `dump-profile` block (after line 44), before the `crawl` block:

```typescript
} else if (command === "inspect") {
  const url = args[1];
  if (!url) {
    console.error("Usage: fera-crawler inspect <url> [--browser-profile PATH]");
    process.exit(1);
  }
  const browserProfile = getFlag("--browser-profile", "");
  openInspector(url, browserProfile || undefined)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Inspector error:", err);
      process.exit(1);
    });
```

**Step 4: Run type check**

Run: `cd sidecar && npx tsc --noEmit`
Expected: Should pass (the missing `scraper` field on CrawlResult will error — that's addressed in Task 3).

**Step 5: Commit**

```bash
git add sidecar/src/inspector.ts sidecar/src/index.ts sidecar/src/crawler.ts
git commit -m "feat(scraper): add inspect sidecar command with visual element picker"
```

---

## Task 3: Add Scraper Extraction to Crawl Pipeline

**Files:**
- Modify: `sidecar/src/index.ts:45-112` (crawl command arg parsing)
- Modify: `sidecar/src/crawler.ts:367-371` (CrawlPageOpts), `413` (after EXTRACT_SEO_SCRIPT evaluate), `452-500` (return object)
- Modify: `sidecar/src/types.ts` (CrawlConfig — already done in Task 1)

**Step 1: Add `--scraper-rules` CLI flag parsing**

In `sidecar/src/index.ts`, in the crawl command block, after `const downloadOgImage = hasFlag("--download-og-image");` (line 90), add:

```typescript
  const scraperRulesRaw = getFlag("--scraper-rules", "");
  let scraperRules: Array<{ name: string; selector: string }> | undefined;
  if (scraperRulesRaw) {
    try {
      scraperRules = JSON.parse(scraperRulesRaw);
    } catch {
      console.error("Error: --scraper-rules must be a valid JSON string");
      process.exit(1);
    }
  }
```

Add to the config object (after `downloadOgImage` spread):

```typescript
    ...(scraperRules ? { scraperRules } : {}),
```

**Step 2: Thread scraper rules through CrawlPageOpts**

In `sidecar/src/crawler.ts`, modify the `CrawlPageOpts` interface (line 367):

```typescript
interface CrawlPageOpts {
  downloadOgImage?: boolean;
  downloadDir?: string;
  userAgent?: string;
  scraperRules?: Array<{ name: string; selector: string }>;
}
```

Where `crawlPageOpts` is constructed (around line 571-573), add scraper rules:

```typescript
  const crawlPageOpts: CrawlPageOpts = {
    ...(config.downloadOgImage ? { downloadOgImage: true, downloadDir: ogImageDownloadDir, userAgent: config.userAgent } : {}),
    ...(config.scraperRules?.length ? { scraperRules: config.scraperRules } : {}),
  };
```

**Step 3: Add scraper extraction after page.evaluate**

In `crawlPage()`, after line 413 (`const data: any = await page.evaluate(EXTRACT_SEO_SCRIPT);`), add:

```typescript
    // Run scraper rules
    const scraper: Record<string, { value: string; appears: boolean }> = {};
    if (opts?.scraperRules?.length) {
      const scraperData = await page.evaluate((rules: Array<{ name: string; selector: string }>) => {
        const results: Record<string, { value: string; appears: boolean }> = {};
        for (const rule of rules) {
          const el = document.querySelector(rule.selector);
          results[rule.name] = {
            value: el ? (el.textContent || "").trim().substring(0, 1000) : "",
            appears: !!el,
          };
        }
        return results;
      }, opts.scraperRules);
      Object.assign(scraper, scraperData);
    }
```

**Note:** This uses a function-argument `page.evaluate` (not a string) which is fine here because scraper rules are simple and don't need the string-literal workaround.

**Step 4: Add `scraper` to the return object**

In the return object (around line 497, after `metaTags: data.metaTags,`), add:

```typescript
        scraper,
```

**Step 5: Run type check and tests**

Run: `cd sidecar && npx tsc --noEmit`
Expected: PASS

Run: `cd /home/dsottimano/source/fera && npm test`
Expected: Existing tests pass (scraper field defaults to `{}` which is fine).

**Step 6: Commit**

```bash
git add sidecar/src/index.ts sidecar/src/crawler.ts
git commit -m "feat(scraper): extract custom scraper rules during crawl via page.querySelector"
```

---

## Task 4: Add Rust `open_inspector` Command

**Files:**
- Modify: `src-tauri/src/commands.rs:252-328` (duplicate `open_browser` as `open_inspector`)
- Modify: `src-tauri/src/lib.rs:80-86` (register new command)

**Step 1: Add `open_inspector` Tauri command**

In `src-tauri/src/commands.rs`, after the `open_browser` function (after line 328), add a new function. It's nearly identical to `open_browser` but spawns sidecar with `"inspect"` instead of `"open-browser"`:

```rust
#[tauri::command]
pub async fn open_inspector(app: AppHandle, url: String) -> Result<(), String> {
    let state: State<BrowserChild> = app.state();

    {
        let mut guard = lock_or_recover(&state.child);
        if let Some(old_child) = guard.take() {
            let _ = old_child.kill();
        }
    }
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    let shell = app.shell();
    let profile = browser_profile_dir(&app);

    let args = vec!["inspect", &url, "--browser-profile", &profile];

    let mut cmd = shell
        .sidecar("fera-crawler")
        .map_err(|e| format!("Failed to create sidecar command: {e}"))?
        .args(&args);

    if let Some(res_dir) = resource_dir(&app) {
        cmd = cmd.env("FERA_RESOURCES_DIR", res_dir);
    }

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn inspector: {e}"))?;

    *lock_or_recover(&state.child) = Some(child);

    let app_handle = app.clone();

    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    if let Ok(result) = serde_json::from_str::<serde_json::Value>(&line_str) {
                        if result.get("event").and_then(|v| v.as_str()) == Some("profile-data") {
                            let _ = app_handle.emit("profile-data", &result);
                        } else {
                            let _ = app_handle.emit("browser-event", result);
                        }
                    }
                }
                CommandEvent::Stderr(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    eprintln!("[inspector stderr] {}", line_str);
                }
                CommandEvent::Terminated(_) => {
                    break;
                }
                _ => {}
            }
        }

        if let Some(state) = app_handle.try_state::<BrowserChild>() {
            if state.generation.load(Ordering::SeqCst) == gen {
                let _ = app_handle.emit("browser-closed", ());
                *lock_or_recover(&state.child) = None;
            }
        }
    });

    Ok(())
}
```

**Step 2: Register the command**

In `src-tauri/src/lib.rs`, add `commands::open_inspector` to the invoke_handler (around line 80-86):

```rust
.invoke_handler(tauri::generate_handler![
    commands::start_crawl,
    commands::stop_crawl,
    commands::open_browser,
    commands::close_browser,
    commands::dump_profile,
    commands::open_inspector,
])
```

**Step 3: Verify Rust compiles**

Run: `cd src-tauri && cargo check`
Expected: PASS

**Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(scraper): add open_inspector Tauri command for visual element picker"
```

---

## Task 5: Add `scraper_rules` to `start_crawl` Rust Command

**Files:**
- Modify: `src-tauri/src/commands.rs:104-184` (start_crawl function)

**Step 1: Add `scraper_rules` parameter and arg passing**

In `start_crawl` function signature (line 104), add after `download_og_image: Option<bool>,`:

```rust
    scraper_rules: Option<String>,
```

In the args building section, after the `download_og_image` block (after line 184), add:

```rust
    if let Some(rules) = scraper_rules {
        args.push("--scraper-rules".to_string());
        args.push(rules);
    }
```

**Step 2: Verify Rust compiles**

Run: `cd src-tauri && cargo check`
Expected: PASS

**Step 3: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(scraper): pass scraper_rules through start_crawl to sidecar CLI"
```

---

## Task 6: Frontend — Scraper Config UI in ConfigModal

**Files:**
- Modify: `frontend/src/components/ConfigModal.vue` (add Scraper section)
- Modify: `frontend/src/composables/useBrowser.ts` (or create new `useInspector.ts`)

**Step 1: Create `useInspector` composable**

Create `frontend/src/composables/useInspector.ts`:

```typescript
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface PickedSelector {
  selector: string;
  tag: string;
  text: string;
  dimensions: string;
}

export function useInspector() {
  const inspecting = ref(false);
  let cleanupListeners: (() => void) | null = null;

  async function openInspector(
    url: string,
    onPick: (picked: PickedSelector) => void,
  ) {
    if (cleanupListeners) {
      cleanupListeners();
      cleanupListeners = null;
    }

    inspecting.value = true;

    const unlistenEvent = await listen<{ event: string; selector: string; tag: string; text: string; dimensions: string }>(
      "browser-event",
      (event) => {
        const data = event.payload;
        if (data.event === "selector-picked") {
          onPick({
            selector: data.selector,
            tag: data.tag,
            text: data.text,
            dimensions: data.dimensions,
          });
        }
      },
    );

    const unlistenClose = await listen<void>("browser-closed", () => {
      inspecting.value = false;
      cleanup();
    });

    function cleanup() {
      unlistenEvent();
      unlistenClose();
      cleanupListeners = null;
    }

    cleanupListeners = cleanup;

    try {
      await invoke("open_inspector", { url });
    } catch (e) {
      console.error("Open inspector failed:", e);
      inspecting.value = false;
      cleanup();
    }
  }

  async function closeInspector() {
    try {
      await invoke("close_browser");
    } catch (e) {
      console.error("Close inspector failed:", e);
    }
    inspecting.value = false;
    if (cleanupListeners) {
      cleanupListeners();
      cleanupListeners = null;
    }
  }

  return { inspecting, openInspector, closeInspector };
}
```

**Step 2: Add Scraper section to ConfigModal**

In `frontend/src/components/ConfigModal.vue`:

Add to `<script setup>`:

```typescript
import { useInspector } from "../composables/useInspector";
import type { ScraperRule } from "../types/crawl";

const { inspecting, openInspector, closeInspector } = useInspector();
const scraperUrl = ref("");

function handleSelectorPicked(picked: { selector: string; tag: string; text: string }) {
  // Auto-generate a name from the tag
  const baseName = picked.tag;
  let name = baseName;
  let i = 1;
  while (config.scraperRules.some((r: ScraperRule) => r.name === name)) {
    name = baseName + "_" + (++i);
  }
  config.scraperRules.push({ name, selector: picked.selector });
}

function removeScraperRule(index: number) {
  config.scraperRules.splice(index, 1);
}

function startInspector() {
  const url = scraperUrl.value.trim();
  if (!url) return;
  openInspector(url, handleSelectorPicked);
}
```

Add to `<template>`, after the Custom Headers section divider (before `</div><!-- modal-body -->`):

```html
        <!-- Scraper -->
        <div class="divider" />
        <div class="section-label">Scraper</div>
        <div class="scraper-launch">
          <input v-model="scraperUrl" type="text" placeholder="https://example.com" class="scraper-url" />
          <button v-if="!inspecting" class="inspector-btn" @click="startInspector">Open Inspector</button>
          <button v-else class="inspector-btn inspector-btn--active" @click="closeInspector">Close Inspector</button>
        </div>
        <div v-if="inspecting" class="inspector-status">Inspecting — click elements on the page to add selectors</div>
        <div v-if="config.scraperRules.length" class="scraper-rules">
          <div v-for="(rule, i) in config.scraperRules" :key="i" class="scraper-rule">
            <input v-model="rule.name" type="text" class="rule-name" placeholder="name" />
            <input v-model="rule.selector" type="text" class="rule-selector" placeholder="CSS selector" />
            <button class="rm" @click="removeScraperRule(i)">&times;</button>
          </div>
        </div>
```

Add styles (inside `<style scoped>`):

```css
.scraper-launch { display: flex; gap: 6px; }
.scraper-url { flex: 1; padding: 8px 12px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #fff; font-size: 11px; outline: none; }
.scraper-url:focus { border-color: rgba(86,156,214,0.5); }
.inspector-btn { padding: 8px 14px; background: rgba(78,201,176,0.1); color: #4ec9b0; border: 1px solid rgba(78,201,176,0.3); border-radius: 8px; cursor: pointer; font-size: 10px; font-weight: 700; letter-spacing: 0.5px; white-space: nowrap; transition: all 0.15s; }
.inspector-btn:hover { background: rgba(78,201,176,0.2); border-color: rgba(78,201,176,0.5); }
.inspector-btn--active { background: rgba(244,71,71,0.1); color: #f44747; border-color: rgba(244,71,71,0.3); }
.inspector-btn--active:hover { background: rgba(244,71,71,0.2); border-color: rgba(244,71,71,0.5); }
.inspector-status { font-size: 10px; color: #4ec9b0; font-weight: 600; letter-spacing: 0.5px; }
.scraper-rules { display: flex; flex-direction: column; gap: 4px; }
.scraper-rule { display: flex; align-items: center; gap: 6px; }
.rule-name { width: 100px; padding: 7px 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #569cd6; font-size: 11px; font-weight: 600; outline: none; }
.rule-name:focus { border-color: rgba(86,156,214,0.5); }
.rule-selector { flex: 1; padding: 7px 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; color: rgba(255,255,255,0.5); font-size: 11px; font-family: 'SF Mono','Cascadia Code','Consolas',monospace; outline: none; }
.rule-selector:focus { border-color: rgba(86,156,214,0.5); color: #fff; }
```

**Step 3: Run type check**

Run: `cd frontend && ../node_modules/.bin/vue-tsc --noEmit`
Expected: May fail on `useDatabase.ts` (missing `scraper` mapping) — fixed in Task 7.

**Step 4: Commit**

```bash
git add frontend/src/composables/useInspector.ts frontend/src/components/ConfigModal.vue
git commit -m "feat(scraper): add inspector UI to config modal with selector list management"
```

---

## Task 7: Frontend — Pass Scraper Rules to Crawl + Database Storage

**Files:**
- Modify: `frontend/src/composables/useCrawl.ts:78-93` (add scraperRules to invoke args)
- Modify: `frontend/src/composables/useDatabase.ts:43-56` (pack scraper into seo_json), `111-156` (unpack)

**Step 1: Pass scraper rules in useCrawl.ts invoke**

In `useCrawl.ts`, in the `invoke("start_crawl", {...})` call, after `downloadOgImage` (line 92), add:

```typescript
    scraperRules: config.scraperRules.length
      ? JSON.stringify(config.scraperRules)
      : null,
```

**Step 2: Pack scraper data into seo_json**

In `useDatabase.ts`, in the `seoJson` stringify object (around line 43-56), add after `ogImageFileSize`:

```typescript
      scraper: result.scraper || {},
```

**Step 3: Unpack scraper data from seo_json**

In `useDatabase.ts`, in the `loadSessionResults` mapper (around line 111-156), add after `metaTags`:

```typescript
        scraper: seo.scraper ?? {},
```

**Step 4: Run type check**

Run: `cd frontend && ../node_modules/.bin/vue-tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add frontend/src/composables/useCrawl.ts frontend/src/composables/useDatabase.ts
git commit -m "feat(scraper): pass scraper rules to crawl invoke and persist results in seo_json"
```

---

## Task 8: Frontend — Dynamic Scraper Columns in CrawlGrid

**Files:**
- Modify: `frontend/src/components/CrawlGrid.vue` (dynamic columns from scraper config)
- Modify: `frontend/src/components/BottomPanel.vue` (scraper rows in detail view)

**Step 1: Add dynamic scraper columns to CrawlGrid**

In `CrawlGrid.vue`, the grid needs to generate columns dynamically based on `scraperRules` from config. The component needs access to the config.

Add import and config access in `<script setup>`:

```typescript
import { useConfig } from "../composables/useConfig";
const { config } = useConfig();
```

Find where columns are assembled for the active tab (where `TAB_COLUMNS` is used to set columns on the Tabulator instance). After the static columns are set, append dynamic scraper columns:

```typescript
function getScraperColumns(): any[] {
  return config.scraperRules.flatMap((rule) => [
    {
      title: rule.name,
      field: `_scraper_${rule.name}`,
      minWidth: 120,
      widthGrow: 1,
      tooltip: true,
      mutator: (value: any, data: any) => data.scraper?.[rule.name]?.value ?? "",
    },
    {
      title: `${rule.name} appears`,
      field: `_scraper_${rule.name}_appears`,
      width: 100,
      hozAlign: "center" as const,
      mutator: (value: any, data: any) => data.scraper?.[rule.name]?.appears ?? false,
      formatter: (cell: any) => cell.getValue() ? "Yes" : "",
    },
  ]);
}
```

In the table column update logic (where `table.setColumns(...)` is called when tab changes), append scraper columns:

```typescript
const cols = [...TAB_COLUMNS[activeTab], ...getScraperColumns()];
table.setColumns(cols);
```

**Step 2: Add scraper rows to BottomPanel**

In `frontend/src/components/BottomPanel.vue`, find the `ogRows` computed and add a `scraperRows` computed after it:

```typescript
const scraperRows = computed(() => {
  const r = props.selectedResult;
  if (!r || !r.scraper) return [];
  return Object.entries(r.scraper).flatMap(([name, data]) => [
    { name, value: data.value || "(empty)" },
    { name: `${name} appears`, value: data.appears ? "Yes" : "No" },
  ]);
});
```

Add a Scraper section in the template where other detail rows are rendered (after the OG section). Use the same table/list pattern as the existing sections:

```html
<template v-if="scraperRows.length">
  <div class="section-label">Scraper</div>
  <div class="detail-row" v-for="row in scraperRows" :key="row.name">
    <span class="label">{{ row.name }}</span>
    <span class="value">{{ row.value }}</span>
  </div>
</template>
```

**Step 3: Run type check**

Run: `cd frontend && ../node_modules/.bin/vue-tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add frontend/src/components/CrawlGrid.vue frontend/src/components/BottomPanel.vue
git commit -m "feat(scraper): dynamic scraper columns in grid and bottom panel detail view"
```

---

## Task 9: Integration Test

**Files:**
- Create: `sidecar/tests/integration/scraper.test.ts`
- Modify: `sidecar/test-server/routes.ts` (add fixture route if needed)

**Step 1: Create test fixture**

Create `sidecar/test-server/fixtures/scraper-page.html`:

```html
<!DOCTYPE html>
<html>
<head><title>Scraper Test</title></head>
<body>
  <h1 class="main-headline">Test Headline</h1>
  <div class="price">$29.99</div>
  <span class="sku" data-testid="product-sku">SKU-12345</span>
  <p class="missing-on-purpose-class">This won't be targeted</p>
</body>
</html>
```

Add route in `sidecar/test-server/routes.ts`:

```typescript
app.get("/scraper", (req, res) => {
  res.sendFile(path.join(fixturesDir, "scraper-page.html"));
});
```

**Step 2: Write the integration test**

Create `sidecar/tests/integration/scraper.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { chromium } from "playwright-core";
import { crawlPage } from "../../src/crawler.js";
// Note: crawlPage needs to be exported — add export if not already

describe("scraper extraction", () => {
  it("extracts text and presence for matching selectors", async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      const { result } = await crawlPage(page, "http://localhost:5000/scraper", {
        scraperRules: [
          { name: "headline", selector: "h1.main-headline" },
          { name: "price", selector: ".price" },
          { name: "missing", selector: ".nonexistent-class" },
        ],
      });

      expect(result.scraper.headline.value).toBe("Test Headline");
      expect(result.scraper.headline.appears).toBe(true);

      expect(result.scraper.price.value).toBe("$29.99");
      expect(result.scraper.price.appears).toBe(true);

      expect(result.scraper.missing.value).toBe("");
      expect(result.scraper.missing.appears).toBe(false);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it("returns empty scraper object when no rules provided", async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      const { result } = await crawlPage(page, "http://localhost:5000/scraper");
      expect(result.scraper).toEqual({});
    } finally {
      await context.close();
      await browser.close();
    }
  });
});
```

**Step 3: Export `crawlPage` from crawler.ts if not already exported**

Check if `crawlPage` has `export` keyword. If not, add it:

```typescript
export async function crawlPage(
```

**Step 4: Run the test**

Run: `npm run test:server` (in one terminal)
Run: `npm test -- --testPathPattern=scraper`
Expected: PASS — both tests green.

**Step 5: Commit**

```bash
git add sidecar/tests/integration/scraper.test.ts sidecar/test-server/fixtures/scraper-page.html sidecar/test-server/routes.ts sidecar/src/crawler.ts
git commit -m "test(scraper): add integration tests for scraper extraction"
```

---

## Task 10: Final Type Check + Smoke Test

**Step 1: Full type check across both packages**

Run: `cd sidecar && npx tsc --noEmit`
Expected: PASS

Run: `cd frontend && ../node_modules/.bin/vue-tsc --noEmit`
Expected: PASS

**Step 2: Run all existing tests**

Run: `npm test`
Expected: All tests pass, no regressions.

**Step 3: Manual smoke test**

Run: `npm run dev`

1. Open Configuration → verify Scraper section appears with URL input + "Open Inspector" button
2. Enter a URL, click "Open Inspector" → browser window should open with hover highlights
3. Hover over elements → blue overlay + tooltip with tag.classes and dimensions
4. Click element → selector appears in the modal list with auto-generated name
5. Close browser → "inspecting" status clears
6. Edit a rule name and selector in the list
7. Start a crawl → verify custom columns appear in grid with extracted values

**Step 4: Commit any fixes from smoke test**

```bash
git add -A
git commit -m "fix(scraper): smoke test fixes"
```
