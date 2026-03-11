# Fera Windows Build — Investigation & Steps

## Problem
The Windows build can't crawl. Chromium launches but the network service crashes or requests time out.

## Root Cause Investigation

### Attempt 1: esbuild bundle → single CJS file
- **Result**: `Cannot read properties of undefined (reading 'bind')` — MemoryStorage error
- **Why**: esbuild bundling breaks circular dependencies between `@crawlee/core` and `@crawlee/memory-storage`
- **Also**: `require.resolve("../../../package.json")` in playwright-core fails (patched with esbuild plugin but other issues remained)

### Attempt 2: @yao-pkg/pkg → standalone exe
- **Result**: Multiple failures — missing modules, missing data files
- **Why**: pkg can't handle dynamic `require()` in Crawlee's `BrowserLauncher.requireLauncherOrThrow()`, and its virtual filesystem misses runtime data files like `headers-order.json`

### Attempt 3: Bun compile → standalone exe
- **Result**: Chrome launches, network service crashes, requests hang forever
- **Why**: Playwright's internal HTTP proxy (`--proxy-server=http://127.0.0.1:PORT`) and `--remote-debugging-pipe` don't work with Bun's runtime. Bun's net/http implementation differs from Node.js enough to break Playwright's browser communication.
- **Error**: `Network service crashed or was terminated, restarting service.`

### Key Insight
`npx tsx sidecar/src/index.ts` works perfectly on Windows CI with plain Node.js. The problem was never Windows or Chromium — it was compiling Node.js code with complex dependencies (Crawlee + Playwright) into standalone executables. All bundler/compiler tools break these libraries.

## Solution: Rust Launcher + Portable Node.js

Instead of compiling to a standalone exe, ship:
1. **Tiny Rust launcher** (`sidecar-launcher/main.rs`) — the Tauri sidecar binary
2. **Portable `node.exe`** — downloaded in CI, bundled as a Tauri resource
3. **tsc-compiled JS** + **real `node_modules`** — in `sidecar-bundle/`
4. **Bundled Chromium** — copied from Playwright's install

The launcher finds `node.exe` and the script, sets `FERA_RESOURCES_DIR`, and spawns Node.js.

## Files Changed

| File | Change |
|------|--------|
| `sidecar-launcher/main.rs` | New — Rust launcher that spawns node.exe with the script |
| `sidecar/src/crawler.ts` | Use `FERA_RESOURCES_DIR` for Chromium path, static `import { chromium }`, `useFingerprints: false`, pass `launcher: chromium` |
| `sidecar/package.json` | Build script changed from esbuild to `tsc` |
| `sidecar/esbuild.config.mjs` | Added `@crawlee/memory-storage` to externals (kept for local dev) |
| `.github/workflows/build.yml` | Full rewrite: tsc + rustc launcher + node.exe download + npm install prod deps + Chromium bundling |

## CI Pipeline Steps

1. `npm install` — workspace dependencies
2. `npx playwright install chromium` — download Chromium
3. `npm run build --workspace=sidecar` — tsc compile TypeScript → JS
4. `rustc sidecar-launcher/main.rs` → tiny .exe in `src-tauri/binaries/`
5. Download portable `node.exe` v22.14.0 → `src-tauri/node/`
6. Stage sidecar runtime: copy compiled JS + `npm install --omit=dev` → `src-tauri/sidecar-bundle/`
7. Copy Chromium → `src-tauri/chromium/`, patch `tauri.conf.json` resources array
8. Smoke test: run launcher exe → should crawl example.com
9. `npx tauri build` → NSIS installer
10. Upload installer to GitHub release

## CI Errors Encountered & Fixes

| # | Error | Cause | Fix |
|---|-------|-------|-----|
| 1 | `%1 is not a valid Win32 application` (npx) | `npx` is a `.cmd` on Windows, `Start-Process` can't run it | Use `cmd.exe /c npx ...` |
| 2 | `Could not resolve "electron"` (Bun) | playwright-core ships Electron support code | `--external electron` |
| 3 | `Network service crashed` (Bun exe) | Bun runtime incompatible with Playwright's internal proxy | Abandoned Bun compile |
| 4 | `MemoryStorage bind error` (esbuild) | Circular dependency broken by bundling | Abandoned esbuild, use tsc |
| 5 | `couldn't create a temp dir` (rustc) | `src-tauri/binaries/` directory doesn't exist | Added `New-Item -ItemType Directory -Force` before rustc |

## Current Status

- Fix #5 applied, pushing to CI for next test run.
- Expecting the smoke test to actually execute this time (launcher is ~200KB, not 117MB like Bun binary).
- If smoke test passes, Tauri build should produce a working installer.
