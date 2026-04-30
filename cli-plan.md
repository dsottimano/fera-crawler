# Fera CLI Plan

Replace the (retired) MCP server with a thin CLI that drives the running Tauri app via a localhost HTTP control plane. Goal: Claude Code (and smart humans) can trigger any UI action and see the app react in real time.

## Goals

- Claude Code skill calls `fera-cli ...` instead of MCP tools → low token cost (skill loads on trigger; output is shaped by us).
- Non-technical colleagues watch the app animate while Claude works (crawl progress, grid updates, etc.).
- Cross-platform: macOS / Windows / Linux. No platform-specific code in the CLI.

## Non-goals

- Standalone CLI that operates without the app open. (Out of scope — colleagues need to see motion.)
- Remote control over the network. Bind localhost-only.
- Replacing UI; CLI is a peer surface, not a substitute.

## Architecture

```
Claude Code
    │  spawns
    ▼
fera-cli (Node, distributed via npm or compiled binary)
    │  HTTP POST 127.0.0.1:<port>/<route>
    ▼
Tauri app (running)
    ├─ Axum server (new) — thin route handlers
    ├─ core::* fns (extracted from commands.rs)  ◄── single source of truth
    ├─ existing Tauri commands → call core::*    ◄── 3-line wrappers
    └─ existing emit() → Vue listeners → UI animates
```

**Key invariant:** the CLI cannot do anything the UI can't already do, because both call the same core fns. All existing safety (single-flight probe, atomic generation flags, `lock_or_recover`, `CrawlChild` kill-on-restart) protects both callers identically.

## Extraction scan results (2026-04-29)

| Group | Files | Difficulty |
|---|---|---|
| Read commands | `db_query.rs` (8 cmds) | Trivial — already pool-based, no AppHandle coupling |
| Orchestration | `commands.rs` (13 cmds, ~1270 LOC) | Mechanical — change `app: AppHandle` → `app: &AppHandle` in core fns, leave `app.emit()` calls in place |
| Voice | `voice_commands.rs` (2 cmds) | Skip in v1 |

`app.emit()` calls stay put — they're the mechanism that makes the UI react. That's the feature, not a coupling problem.

## Phases

### Phase 1 — Rust HTTP control plane (no CLI yet)
1. Add deps: `axum`, `tower`, `tokio` features. Pin exact versions.
2. New file `src-tauri/src/core.rs` — extract bodies from existing `#[tauri::command]` fns. Each takes `&AppHandle` plus typed args, returns `Result<T, String>`.
3. Rewrite Tauri commands as 3-line wrappers calling `core::*`.
4. New file `src-tauri/src/http.rs` — Axum router. One route per core fn. Bind `127.0.0.1:<port>`.
5. Port allocation: try fixed `7777`, fall back to OS-assigned. Write actual port to `<app_config_dir>/cli.port` lockfile so CLI can find it.
6. Spawn server in `lib.rs` `setup()` via `tauri::async_runtime::spawn`. Supervised — log on crash, don't take down app.
7. **Verify:** `tsc --noEmit` equivalent (`cargo check`), then `curl 127.0.0.1:7777/health` while app runs. Then manually `curl` a probe call and watch UI animate.

**Stop here. Get approval before Phase 2.**

### Phase 2 — Node CLI
1. New `cli/` dir. `package.json` with bin entry `fera-cli`.
2. Use `env-paths` to find `<app_config_dir>/cli.port` — same convention as Tauri's app_config_dir per OS.
3. Each subcommand = thin wrapper: parse args → POST to localhost → stream/print response.
4. If port file missing or connection refused: clear error ("Fera app is not running. Open it and retry.").
5. Output modes: human-readable default, `--json` for Claude.
6. Distribute via `npm i -g @fera/cli` initially. `bun build --compile` for single-binary later if needed.

**Verify:** `fera-cli probe https://example.com` from terminal animates the running app. Same call from a Claude Code skill works identically.

### Phase 3 — Claude Code skill
1. Skill markdown in `.claude/skills/fera/` documenting CLI surface.
2. Trigger phrases: "crawl X with fera", "probe X", "show fera health", etc.
3. Skill body: list of commands + when to use which. Skill loads only when triggered → ~0 idle token cost.

## Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Logic drift between UI and CLI | Medium | Single core fn per operation; both surfaces are thin wrappers |
| Port conflicts | Low | Fallback to OS-assigned port; lockfile carries the truth |
| HTTP server crash | Low | Supervised task; log + restart, never propagate to app |
| Concurrent crawl from UI + CLI | Low | Existing `CrawlChild` atomic flags handle this — same protection as two UI clicks |
| Localhost security | Low | Bind `127.0.0.1` only; any local process can hit it (acceptable for a desktop app) |

## Open decisions

- **Auth on the HTTP plane?** Probably none for v1 (localhost only, single-user desktop). Add a per-app-launch random token in the lockfile if we ever want defense-in-depth.
- **Streaming responses?** WebSocket vs SSE vs poll. Defer until we have a use case (most CLI calls are fire-and-forget; the UI already shows progress).
- **Voice commands**: in or out of v1? Lean out.

## Estimated effort

- Phase 1: 1-2 days (most of it testing)
- Phase 2: half a day
- Phase 3: 1-2 hours

Total: ~3 days of careful work.
