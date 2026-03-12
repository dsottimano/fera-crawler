# Fera — Architecture & Developer Instructions

## What is Fera?

Fera is a cross-platform desktop SEO crawler (a Screaming Frog alternative). It crawls websites, extracts SEO data (titles, H1s, meta descriptions, canonicals, links, status codes, response headers), and presents the results in a sortable/filterable grid.

It runs as a native desktop app on Linux, Windows, and macOS.

---

## Tech Stack

| Layer | Technology | Location |
|-------|-----------|----------|
| Desktop runtime | Tauri v2 (Rust) | `src-tauri/` |
| Frontend | Vue 3 + TypeScript + Vite | `frontend/` |
| Crawler engine | Node.js + Playwright-Core | `sidecar/` |
| Sidecar launcher | Rust binary | `sidecar-launcher/` |
| Data grid | Tabulator.js | (npm dep in frontend) |
| Database | SQLite via tauri-plugin-sql | (managed by Tauri) |
| CI/CD | GitHub Actions | `.github/workflows/` |

---

## Architecture Overview

```
User clicks START
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│  FRONTEND  (Vue 3 + Vite)                                │
│                                                          │
│  App.vue  ──►  useCrawl.ts  ──►  invoke("start_crawl")  │
│                     │                                    │
│                     ▼                                    │
│              listen("crawl-result")  ──►  CrawlGrid.vue  │
│              listen("crawl-complete")                    │
│                     │                                    │
│                     ▼                                    │
│              useDatabase.ts  ──►  SQLite (fera.db)       │
└──────────────────────┬───────────────────────────────────┘
                       │  Tauri IPC (invoke / emit)
                       ▼
┌──────────────────────────────────────────────────────────┐
│  TAURI BACKEND  (Rust)                                   │
│                                                          │
│  commands.rs:                                            │
│    start_crawl()  ──►  shell.sidecar("fera-crawler")     │
│    stop_crawl()   ──►  child.kill() + kill Chrome        │
│    open_browser() ──►  sidecar open-browser mode         │
│    close_browser()──►  child.kill() + kill Chrome        │
│    dump_profile() ──►  sidecar dump-profile mode         │
│                                                          │
│  lib.rs:                                                 │
│    SQLite migrations (crawl_sessions, crawl_results)     │
│    Plugin registration (shell, sql, dialog, fs, opener)  │
└──────────────────────┬───────────────────────────────────┘
                       │  Spawns child process
                       ▼
┌──────────────────────────────────────────────────────────┐
│  SIDECAR  (Node.js + Playwright-Core)                    │
│                                                          │
│  index.ts  ──►  CLI arg parsing                          │
│  crawler.ts:                                             │
│    runCrawler()   ──►  Chromium (headless or headed)     │
│    openBrowser()  ──►  Chromium (visible, for sign-in)   │
│    dumpProfile()  ──►  Chromium (headless, read cookies) │
│                                                          │
│  Output: NDJSON to stdout  ──►  Tauri reads & emits      │
└──────────────────────────────────────────────────────────┘
```

### How the pieces connect

1. **Frontend → Backend**: Vue calls `invoke("start_crawl", {...})` which triggers a Rust function
2. **Backend → Sidecar**: Rust spawns a child process: `fera-crawler crawl <url> [flags]`
3. **Sidecar → Chromium**: Playwright-Core drives a real Chromium browser
4. **Sidecar → Backend**: Each crawled page is written to stdout as a JSON line (NDJSON)
5. **Backend → Frontend**: Rust reads stdout, parses JSON, emits `crawl-result` Tauri events
6. **Frontend → Database**: Each result is also persisted to SQLite as it arrives

---

## Directory Structure

```
fera/
├── package.json                    # Root workspace (npm workspaces)
├── package-lock.json
├── instructions.md                 # This file
├── CLAUDE.md                       # AI assistant instructions
│
├── frontend/                       # Vue 3 desktop UI
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html                  # Entry HTML (loads Ubuntu font)
│   ├── designrules.md              # UI design system reference
│   └── src/
│       ├── main.ts                 # Vue app mount
│       ├── App.vue                 # Main shell (telemetry bar, mode switcher, layout)
│       ├── types/
│       │   └── crawl.ts            # CrawlResult, CrawlConfig, defaultConfig
│       ├── composables/
│       │   ├── useCrawl.ts         # Crawl lifecycle (start, stop, events, DB)
│       │   ├── useBrowser.ts       # Sign-in browser & cookie capture
│       │   ├── useConfig.ts        # Reactive crawl config state
│       │   ├── useDatabase.ts      # SQLite CRUD (sessions, results)
│       │   └── useFileOps.ts       # Save/load .fera files, CSV export
│       └── components/
│           ├── MenuBar.vue         # File/Config/Mode/Export/Reports/Help menus
│           ├── CategoryTabs.vue    # 20 filter tabs (Internal, Page Titles, etc.)
│           ├── FilterBar.vue       # URL/status filter dropdowns
│           ├── CrawlGrid.vue       # Tabulator data grid (column sets per tab)
│           ├── BottomPanel.vue     # Selected row details + HTTP Headers tab
│           ├── RightSidebar.vue    # Resource type breakdown + donut chart
│           ├── ConfigModal.vue     # Crawl settings (spider, robots, speed, UA)
│           ├── ReportPanel.vue     # Reports (overview, redirects, duplicates)
│           ├── ProfileViewer.vue   # Cookie/localStorage viewer (card layout)
│           ├── SettingsFinder.vue  # Grid-search mode for optimal crawl config
│           └── AboutModal.vue      # App info dialog
│
├── sidecar/                        # Node.js crawler engine
│   ├── package.json
│   ├── tsconfig.json
│   ├── esbuild.config.mjs          # Build: bundle to dist/index.cjs
│   └── src/
│       ├── index.ts                # CLI entry: crawl | open-browser | dump-profile
│       ├── crawler.ts              # Core: runCrawler, openBrowser, dumpProfile, findChromium
│       ├── pipeline.ts             # writeLine() — NDJSON output to stdout
│       ├── utils.ts                # classifyResource() — Content-Type → ResourceType
│       └── types.ts                # CrawlResult, CrawlConfig, ResourceType
│
├── sidecar-launcher/               # Rust wrapper binary
│   └── main.rs                     # Finds Node.js + sidecar script, exec's it
│
├── src-tauri/                      # Tauri v2 backend
│   ├── Cargo.toml
│   ├── tauri.conf.json             # App config, bundle settings, plugins
│   ├── capabilities/
│   │   └── default.json            # Permissions (shell, sql, dialog, fs, opener)
│   ├── binaries/                   # Dev sidecar shell wrapper lives here
│   ├── chromium/                   # Bundled Chromium (gitignored, populated at build time)
│   └── src/
│       ├── main.rs                 # Entry point
│       ├── lib.rs                  # App init, SQLite migrations, plugin registration
│       └── commands.rs             # Tauri commands (start_crawl, stop_crawl, etc.)
│
├── scripts/
│   └── download-chromium.mjs       # Downloads Chromium from Playwright cache → src-tauri/chromium/
│
└── .github/workflows/
    └── build.yml                   # CI: build + release (Windows, triggers on v* tags)
```

---

## Data Types

### CrawlResult (shared between sidecar and frontend)

```typescript
interface CrawlResult {
  url: string;                              // The crawled URL
  status: number;                           // HTTP status code (200, 404, etc.)
  title: string;                            // <title> content
  h1: string;                               // First <h1> content
  metaDescription: string;                  // <meta name="description"> content
  canonical: string;                        // <link rel="canonical"> href
  internalLinks: number;                    // Count of same-domain links on page
  externalLinks: number;                    // Count of external links on page
  responseTime: number;                     // Milliseconds to load
  contentType: string;                      // Response Content-Type header
  resourceType: ResourceType;               // Classified: HTML, CSS, JS, Image, Font, PDF, Other
  size: number;                             // Response body size in bytes
  error?: string;                           // Error message if navigation failed
  responseHeaders?: Record<string, string>; // All HTTP response headers
  redirectUrl?: string;                     // Final URL if redirected
  serverHeader?: string;                    // Server response header value
}
```

### CrawlConfig

```typescript
interface CrawlConfig {
  startUrl: string;
  maxRequests: number;       // Max pages to crawl
  concurrency: number;       // Parallel tabs (headless) or 1 (headed)
  userAgent?: string;
  respectRobots?: boolean;
  delay?: number;            // ms between requests
  customHeaders?: Record<string, string>;
  mode: "spider" | "list";   // Spider follows links; list crawls specific URLs
  urls?: string[];            // For list mode
  browserProfile?: string;    // Persistent Chromium profile directory
  headless?: boolean;         // true = headless, false = visible browser window
}
```

---

## IPC Protocol

### Frontend → Backend (Tauri invoke)

| Command | Parameters | What it does |
|---------|-----------|-------------|
| `start_crawl` | url, maxRequests, concurrency, userAgent, respectRobots, delay, customHeaders, mode, urls, headless | Spawns sidecar with `crawl` command |
| `stop_crawl` | (none) | Kills sidecar process + Chrome processes |
| `open_browser` | url | Spawns sidecar with `open-browser` command |
| `close_browser` | (none) | Kills browser sidecar + Chrome processes |
| `dump_profile` | url | Spawns sidecar with `dump-profile` command |

### Backend → Frontend (Tauri emit events)

| Event | Payload | When |
|-------|---------|------|
| `crawl-result` | CrawlResult JSON | Each page crawled |
| `crawl-complete` | (none) | Sidecar process exits |
| `browser-event` | JSON | Sidecar stdout (non-profile events) |
| `browser-closed` | (none) | Browser sidecar process exits |
| `profile-data` | `{cookies: [...], localStorage: {...}}` | After sign-in or dump-profile |

### Sidecar CLI Interface

The sidecar binary (`fera-crawler`) accepts three commands:

```bash
# Crawl mode
fera-crawler crawl <url> \
  --max-requests 100 \
  --concurrency 5 \
  --user-agent "MyBot/1.0" \
  --delay 500 \
  --mode spider \
  --browser-profile /path/to/profile \
  --headless false

# Sign-in browser mode
fera-crawler open-browser <url> --browser-profile /path/to/profile

# Dump cookies/storage
fera-crawler dump-profile <url> --browser-profile /path/to/profile
```

Output is always **NDJSON** (one JSON object per line) on stdout. Stderr is for logs/errors.

---

## Database Schema (SQLite)

```sql
-- Migration v1
CREATE TABLE crawl_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_url TEXT NOT NULL,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
);

CREATE TABLE crawl_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    status INTEGER,
    title TEXT,
    h1 TEXT,
    meta_description TEXT,
    canonical TEXT,
    internal_links INTEGER DEFAULT 0,
    external_links INTEGER DEFAULT 0,
    response_time INTEGER DEFAULT 0,
    content_type TEXT,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES crawl_sessions(id)
);

-- Migration v2
ALTER TABLE crawl_results ADD COLUMN resource_type TEXT DEFAULT 'Other';
ALTER TABLE crawl_results ADD COLUMN size INTEGER DEFAULT 0;
```

Database file: `sqlite:fera.db` (managed by tauri-plugin-sql, stored in Tauri's app data directory).

On startup, the app closes any orphaned sessions (where `completed_at IS NULL`) and auto-loads the most recent session.

---

## Chromium Management

### Discovery order (`findChromium()` in `crawler.ts`)

1. `FERA_CHROMIUM_PATH` env var (explicit override)
2. Bundled: `FERA_RESOURCES_DIR/chromium/<binary>`
3. Next to sidecar binary: `../chromium/<binary>`
4. Playwright cache: `~/.cache/ms-playwright/chromium-*/chrome-linux/chrome`

### Browser profile

Persistent Chromium profile directory (cookies, localStorage, sessions survive between runs):

| Platform | Path |
|----------|------|
| Linux | `~/.local/share/com.fera.crawler/browser-profile` |
| macOS | `~/Library/Application Support/com.fera.crawler/browser-profile` |
| Windows | `%APPDATA%\com.fera.crawler\browser-profile` |

The same profile is shared between the sign-in browser and the crawler, so sessions carry over.

### Process cleanup

Killing the Node.js sidecar does NOT kill its Chrome child process. Both `stop_crawl` and `close_browser` (Rust) call `kill_chrome_for_profile()` which:

- **Linux/macOS**: `ps ax | grep --user-data-dir=<path> | kill -9`
- **Windows**: `wmic process where "CommandLine like '%--user-data-dir=<path>%'" call terminate`

The sidecar also calls `killChromeForProfile()` (Node.js version) before launching to clean up stale processes.

---

## Anti-Bot Detection (Stealth)

Sites like thehill.com aggressively block automated browsers. Fera uses these countermeasures:

```typescript
const STEALTH_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  "--disable-features=AutomationControlled",
  "--disable-infobars",
  "--no-first-run",
  "--no-default-browser-check",
  "--password-store=basic",
];
```

Additionally:
- `ignoreDefaultArgs: ["--enable-automation"]` — removes Playwright's automation flag
- `navigator.webdriver` patched to `undefined` via `addInitScript()`
- **Headed mode**: For very aggressive sites, crawl with `headless: false` — single tab, 1s minimum delay, reuses one tab (no open/close chaos)

---

## Headed vs Headless Crawling

| Aspect | Headless (default) | Headed |
|--------|-------------------|--------|
| Browser visible? | No | Yes |
| Concurrency | User-configured (e.g., 5) | Forced to 1 |
| Tab management | New tab per page, parallel | Single tab, sequential |
| Delay | User-configured | Min 1 second |
| Bot detection | More likely to be detected | Looks like a real user |
| Speed | Fast | Slow |

Toggle via the HEADLESS/HEADED pill button in the telemetry bar. When headed, the button turns orange.

---

## Key Workflows

### Crawl with sign-in (for sites that block)

1. Enter URL in telemetry bar
2. Click **SIGN IN** — opens persistent Chromium window
3. Log in to the site manually, browse around
4. Close the browser window — cookies are captured
5. **ProfileViewer** auto-opens showing all stored cookies
6. Click **START** — crawler uses the same profile (cookies carry over)
7. If still blocked, switch to **HEADED** mode and try again

### Settings Finder mode

1. Click Fera logo → select **Settings Finder**
2. Configure: target URL, concurrency values, delay values, user agents
3. Click **Start** — grid-searches all combinations
4. Each combination runs a small crawl sample
5. Results table shows success rate per configuration
6. If 5 consecutive blocks detected → auto-stops, suggests sign-in

---

## Build & Development

### Prerequisites

- Node.js 22+
- Rust toolchain (stable)
- Playwright Chromium: `npx playwright install chromium`

### Development

```bash
# Install all workspace dependencies
npm install

# Run the app in dev mode (Vite HMR + Tauri dev window)
npm run dev

# This is equivalent to: npx tauri dev
# Vite frontend runs on http://localhost:1420
# Tauri opens a native window pointing to it
```

The dev sidecar is a shell wrapper in `src-tauri/binaries/` that calls `npx tsx sidecar/src/index.ts`.

### Building

```bash
# Build sidecar (esbuild → sidecar/dist/index.cjs)
npm run build --workspace=sidecar

# Build the full Tauri app (frontend + sidecar + installer)
npx tauri build
```

### Testing (sidecar)

```bash
# Start the test HTTP server (serves fixture pages on localhost:5000)
npm run test:server --workspace=sidecar

# Run all tests
npm test

# Run unit tests only
npm run test:unit --workspace=sidecar

# Run integration tests only
npm run test:integration --workspace=sidecar
```

### CI/CD

The GitHub Actions workflow (`.github/workflows/build.yml`) triggers on:
- Push of a `v*` tag (e.g., `git tag v0.2.0 && git push origin v0.2.0`)
- Manual workflow dispatch

It builds a Windows NSIS installer and uploads it to a GitHub release.

---

## Sidecar Launcher (`sidecar-launcher/main.rs`)

The sidecar binary that Tauri spawns is NOT Node.js directly. It's a small Rust wrapper that:

1. Looks for `node/node.exe` + `sidecar-bundle/index.js` next to itself (production)
2. Falls back to system `node` + `sidecar/dist/index.js` relative to the binary (dev)
3. Sets `FERA_RESOURCES_DIR` env var
4. Passes all CLI args through to the Node.js script
5. Exits with the Node.js process's exit code

This lets Tauri spawn a single binary (`fera-crawler`) that transparently runs Node.js.

---

## Esbuild Configuration (`sidecar/esbuild.config.mjs`)

The sidecar is bundled into a single CJS file for production:

- **Entry**: `src/index.ts`
- **Output**: `dist/index.cjs` (minified, bundled)
- **Target**: Node.js 22
- **External**: `chromium-bidi` (loaded dynamically by Playwright)
- **Plugin**: Patches Playwright's `require.resolve()` calls that reference files not needed at runtime

---

## URL Normalization

URLs without a protocol are automatically prefixed with `https://`. This happens in:
- `App.vue` `normalizeUrl()` — before starting a crawl or opening the sign-in browser
- `crawler.ts` `ensureProtocol()` — safety net in the sidecar for all three commands

Example: `cnn.com` → `https://cnn.com`

---

## Design System

The UI follows a SpaceX Dragon-inspired dark theme. See `frontend/designrules.md` for the full design system including:
- Color palette (bg-base: #0c111d, accent-primary: #569cd6, etc.)
- Typography (Ubuntu font family, Ubuntu Mono for code)
- Component patterns (pill buttons, bordered panels, status indicators)

---

## Important Gotchas

1. **Sidecar binary name**: Always `fera-crawler`. Tauri appends the target triple automatically (e.g., `fera-crawler-x86_64-unknown-linux-gnu`).

2. **`npm run dev` not `cargo tauri dev`**: The Tauri CLI is installed via npm, not cargo.

3. **Bundle identifier**: `com.fera.crawler` (not `.app` — conflicts with macOS).

4. **Chromium is gitignored**: `src-tauri/chromium/` is in `.gitignore`. CI downloads it fresh. For local dev, Playwright cache is used as fallback.

5. **Two CrawlResult types**: One in `sidecar/src/types.ts` (what the crawler outputs) and one in `frontend/src/types/crawl.ts` (what the UI consumes). They must stay in sync manually.

6. **Two CrawlConfig types**: Same situation — sidecar has `browserProfile` and `startUrl` fields that the frontend version doesn't (those are added at the invoke boundary in `useCrawl.ts`).

7. **Process orphans**: Killing the Node.js sidecar does NOT kill Chrome. Always use `kill_chrome_for_profile()` / `killChromeForProfile()` when stopping.

8. **Persistent context lock**: Only one Chromium instance can use a `--user-data-dir` at a time. The crawler auto-closes the sign-in browser before starting, and removes stale `SingletonLock` files.

9. **Response headers are not persisted**: `responseHeaders` flows through the NDJSON pipeline to the UI but is NOT stored in SQLite (too large/variable). They're available during the crawl session but lost when reloading from DB.

10. **HMR and Tauri**: Vite HMR works for the frontend. Sidecar changes require restarting `npm run dev`. Rust changes trigger a Tauri rebuild automatically.
