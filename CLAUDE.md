# Fera — Project Instructions

## Frontend Design
**ALWAYS read `frontend/designrules.md` before creating or modifying any frontend component.** Every color, font size, spacing value, border radius, and interactive state must follow the rules defined there. No exceptions.

## Architecture
- **Frontend**: `frontend/` — Vue 3 + Vite + Tabulator grid
- **Sidecar**: `sidecar/` — Node.js Playwright crawler, outputs NDJSON to stdout
- **Backend**: `src-tauri/` — Rust Tauri v2, spawns sidecar, emits events to frontend

## Key Commands
- `npm run dev` — start Tauri dev (frontend + backend)
- `npm run dev:frontend` — frontend only (port 1420)
- `npm test` — run sidecar test suite
- `npm run test:server` — start test fixture server on :5000

## Rules
- Sidecar binary name: `fera-crawler` (Tauri appends target triple)
- In `commands.rs`, use `shell.sidecar("fera-crawler")` NOT `"binaries/fera-crawler"`
- Bundle identifier: `com.fera.crawler`
