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
- **State management**: `CrawlChild` and `BrowserChild` are registered in `lib.rs` via `.manage()` before `.run()` — never use `app.manage()` in commands
- **Generation counter**: Always check `state.generation` before emitting `crawl-complete` or `browser-closed` to prevent stale events from killed children
- **No shell interpolation**: Use `Command::new("ps").args(...)` (Rust) or `execFileSync("ps", [...])` (Node) — never pass unsanitized strings to `sh -c` or `execSync`
- **Mutex locks**: Always use `lock_or_recover()` (not `.lock().unwrap()`) to survive poison
- **Event listener cleanup**: All Tauri event listeners must be tracked and cleaned up symmetrically — register both `crawl-result` + `crawl-complete` unlisteners, clean both on stop/complete
- **Tabulator lifecycle**: Always call `table.destroy()` in `onUnmounted`
- **findChromium**: Check multiple platform subdirs (e.g., `chrome-linux64` + `chrome-linux`) for Playwright cache compat
