# Fera — Project Overview

## What is Fera?
A cross-platform desktop SEO crawler — a Screaming Frog alternative built with modern open-source tools. It crawls websites and extracts SEO-relevant data (titles, H1s, meta descriptions, canonicals, link counts, status codes, response times) into a fast, scrollable grid.

## Tech Stack
- **Frontend**: Vue 3 + Vite + TypeScript + Tabulator (virtual-scrolling data grid)
- **Backend**: Tauri v2 (Rust) — lightweight native shell, manages sidecar process and SQLite
- **Crawler**: Node.js sidecar using Crawlee + Playwright (headless Chromium)
- **IPC**: Frontend → Rust commands → spawns sidecar → NDJSON stdout → Rust emits events → Vue updates grid

## Architecture
```
┌─────────────────────────────────────────────────┐
│  Vue 3 Frontend (Tabulator grid)                │
│  invoke("start_crawl") / listen("crawl-result") │
└──────────────────┬──────────────────────────────┘
                   │ Tauri IPC
┌──────────────────▼──────────────────────────────┐
│  Rust Backend (src-tauri/)                       │
│  - Spawns sidecar process                        │
│  - Reads NDJSON from stdout                      │
│  - Emits events to frontend                      │
│  - SQLite via tauri-plugin-sql                   │
└──────────────────┬──────────────────────────────┘
                   │ Process spawn
┌──────────────────▼──────────────────────────────┐
│  Node.js Sidecar (sidecar/)                      │
│  - Crawlee + PlaywrightCrawler                   │
│  - Extracts SEO data per page                    │
│  - Outputs NDJSON lines to stdout                │
└─────────────────────────────────────────────────┘
```

## Directory Structure
```
fera/
├── package.json              # npm workspace root
├── frontend/                 # Vue 3 + Vite + Tabulator
│   └── src/
│       ├── App.vue           # Main UI — URL input, controls, grid
│       ├── components/
│       │   └── CrawlGrid.vue # Tabulator virtual-scrolling table
│       ├── composables/
│       │   └── useCrawl.ts   # Tauri IPC — invoke commands, listen events
│       └── types/
│           └── crawl.ts      # CrawlResult interface
├── sidecar/                  # Node.js crawler
│   └── src/
│       ├── index.ts          # CLI entry: crawl <url> --max-requests N
│       ├── crawler.ts        # PlaywrightCrawler setup + SEO extraction
│       ├── pipeline.ts       # NDJSON stdout writer
│       └── types.ts          # CrawlResult interface (mirrors frontend)
├── src-tauri/                # Rust backend
│   ├── src/
│   │   ├── main.rs           # Entry point
│   │   ├── lib.rs            # Plugin registration, SQLite migrations
│   │   └── commands.rs       # start_crawl, stop_crawl commands
│   ├── capabilities/
│   │   └── default.json      # Shell permissions for sidecar
│   ├── binaries/             # Sidecar wrapper script (dev) or binary (prod)
│   └── tauri.conf.json       # Tauri config
└── .github/workflows/
    └── build.yml             # CI: builds Windows/Linux/macOS installers
```

## Current Status

### Done
- [x] Full monorepo scaffold with working IPC between all 3 layers
- [x] Vue frontend with URL input, start/stop controls, Tabulator grid
- [x] Node.js sidecar crawler using Crawlee + Playwright
- [x] Rust backend with sidecar spawning, NDJSON parsing, event emission
- [x] SQLite schema (crawl_sessions + crawl_results tables) via migrations
- [x] `npm run dev` launches the full stack — crawling works end-to-end
- [x] GitHub repo pushed: https://github.com/dsottimano/fera-crawler
- [x] GitHub Actions CI workflow for cross-platform builds (Windows .msi, Linux .deb/.AppImage, macOS .dmg)

### In Progress
- [ ] CI builds — fixing minor issues (TS types, icons, sidecar wrappers)

### Not Yet Started
- [ ] SQLite persistence — frontend receives events but doesn't write to DB yet
- [ ] Crawl session management (start/stop/resume, session list)
- [ ] CheerioCrawler mode (fast/static crawling without Playwright)
- [ ] Export (CSV, Excel)
- [ ] Sidecar production binary (esbuild + pkg instead of dev wrapper script)
- [ ] Custom icon/branding
- [ ] Robots.txt / sitemap.xml parsing
- [ ] Redirect chain tracking
- [ ] Advanced SEO checks (missing alt text, duplicate titles, etc.)
