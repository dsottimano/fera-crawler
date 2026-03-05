# Fera — SEO Crawler

Cross-platform desktop SEO crawler built with Tauri v2 + Vue 3 + Node.js (Crawlee + Playwright).

## Prerequisites

### Linux (Ubuntu/Debian)
```bash
sudo apt-get update && sudo apt-get install -y \
  libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev libgtk-3-dev \
  libpango1.0-dev libcairo2-dev libgdk-pixbuf2.0-dev \
  libsoup-3.0-dev libjavascriptcoregtk-4.1-dev
```

### All platforms
- [Rust](https://rustup.rs/) (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- [Node.js](https://nodejs.org/) v22+

## Setup

```bash
git clone https://github.com/dsottimano/fera-crawler.git
cd fera-crawler
npm install
npx playwright install chromium
npx tauri icon app-icon.png   # generate icons (or provide your own)
```

## Development

```bash
npm run dev
```

This runs `npx tauri dev`, which starts both the Vite dev server and the Tauri app.

## Build

```bash
npm run build
```

Produces platform-specific installers in `src-tauri/target/release/bundle/`.

## Architecture

```
Vue Frontend → invoke("start_crawl") → Rust Backend
  → spawns sidecar binary → Node.js runs Crawlee + Playwright
  → NDJSON lines on stdout → Rust reads stdout events
  → app.emit("crawl-result") → Vue listens, adds rows to Tabulator grid
```

## Project Structure

- `frontend/` — Vue 3 + Vite + Tabulator
- `sidecar/` — Node.js crawler (Crawlee + Playwright)
- `src-tauri/` — Rust backend (Tauri v2)
