# 2026-04-24 — Immediate wins: speed, stealth, anti-block

**Goal for the session:** ship three categories of fixes that together make Fera materially faster and materially harder to block, without any architectural rewrite. Fresh-context-safe: anyone reading this should be able to execute without reading prior conversation.

**Context pointer:** the bigger direction lives in `docs/plans/future-fera.md`. This plan is the "ship now" slice.

---

## What we're shipping

### A. Resource blocking + close-on-extract (biggest speed win)

**File:** `sidecar/src/crawler.ts` (modify) + `sidecar/src/resource-block.ts` (new, small).

**What it does:** installs a `context.route()` handler that aborts requests for non-essential resource types and known tracker/ad hosts. A typical page loads 50–200 sub-requests; most of them are images, fonts, analytics beacons, ad scripts. Blocking them 3–5× page throughput. Zero functional cost for the SEO fields we extract.

**Design:**
- Block by `request.resourceType()`: `image`, `font`, `media`, `websocket` always; `stylesheet` only when `captureVitals` is off (LCP needs paint).
- Block by host substring against a baked-in list (~30 entries): `google-analytics.com`, `googletagmanager.com`, `doubleclick.net`, `facebook.com/tr`, `hotjar.com`, `fullstory.com`, `segment.com`, `segment.io`, `intercom.io`, `amplitude.com`, `mixpanel.com`, `newrelic.com`, `datadoghq.com`, `bugsnag.com`, `clarity.ms`, `cdn.cookielaw.org`, `onetrust.com`, `chat.olark.com`, `widget.intercom.io`, etc. (Curate list; keep easy to edit.)
- Bypass: allow specific OG image URL when `downloadOgImage` is set (track requested URL, allow through).
- Config-gated via `--block-resources` (default on). `--no-block-resources` opts out.
- Close-on-extract: already handled in `finally` block for parallel path; no change needed for the reusePage (headed) path because we navigate away.

**Acceptance:**
- New integration test: page with `<img>`, Google Analytics script tag, `<link rel="stylesheet">` — assert `failedRequests` or subrequest log shows blocked; page still extracts title/h1.
- Smoke: re-run `/page-with-errors` fixture — verify still captures JS errors (scripts should not be blocked by default; only analytics/trackers).

---

### B. UA rotation + Sec-CH-UA matching + Accept-Language + per-host rate limiting + 429/Retry-After

**Files:** `sidecar/src/stealth.ts` (new, UA pool + header derivation), `sidecar/src/rate-limiter.ts` (new, ~50 LOC), `sidecar/src/crawler.ts` (integration), `sidecar/src/index.ts` (new CLI flags), `src-tauri/src/commands.rs` (passthrough).

**UA pool** — 5 realistic modern UAs (recent Chrome on Win/Mac, Edge on Win, Firefox on Win, Safari on Mac). Sticky per-host: `hash(hostname) % pool.length` picks one; same host always gets the same UA for the duration of a crawl (real sessions don't rotate mid-browse).

**Sec-CH-UA derivation** — only emitted when the chosen UA is Chromium-family (Chrome/Edge). Must include `Sec-CH-UA`, `Sec-CH-UA-Mobile: ?0`, `Sec-CH-UA-Platform: "Windows"` / `"macOS"` derived from the UA string. Mismatch (Firefox UA + Sec-CH-UA headers) is a hard tell for Cloudflare/Akamai.

**Accept-Language / Accept-Encoding** — set realistic defaults: `Accept-Language: en-US,en;q=0.9`, `Accept-Encoding: gzip, deflate, br, zstd`. Configurable later.

**Per-host rate limiter** — tracks `lastRequestTime` and `inFlightCount` per hostname. `acquire(host)` waits if needed. Defaults: `perHostDelay = 500ms`, `perHostConcurrency = 2`. Configurable via flags. Supersedes the global `--delay` concept on a per-host basis (global `--delay` still applies as a floor).

**429/503 handling** — in `crawlPage`, if `response.status()` is 429 or 503, read `Retry-After` header (seconds or HTTP-date), wait up to 60s cap, retry once. If retry also fails, record the response as-is.

**CLI flags:**
- `--rotate-ua` (default on unless `--user-agent` is set)
- `--per-host-delay MS` (default 500)
- `--per-host-concurrency N` (default 2)
- `--block-resources` / `--no-block-resources` (default on)

**Rust passthrough:** extend `start_crawl` with `rotate_ua`, `per_host_delay`, `per_host_concurrency`, `block_resources` optionals.

**Acceptance:**
- Fixture `/show-ua` echoes the request's `User-Agent` + `Sec-CH-UA`. Crawl two hosts (add alias route), assert UAs differ across hosts, same within host.
- Fixture `/rate-limit-test` that returns 429 with `Retry-After: 1` on first hit, 200 on second. Crawl once — assert we retried and got 200, and that `crawlResult.responseTime` reflects the wait.
- Rate-limiter unit test: 3 acquires against same host with 500ms delay complete in ~1000–1500ms.

---

### C. Rebrowser-style stealth patches

**File:** `sidecar/src/stealth.ts` (extend from B).

**What it does:** adds a context `addInitScript` with ~20 patches that hide common automation tells. Beyond the one `navigator.webdriver` patch we already have.

**Patches (must match the chosen UA's platform):**
1. `navigator.webdriver` → `undefined` (already have)
2. `navigator.plugins` → realistic non-empty PluginArray (Chrome PDF Plugin, Chrome PDF Viewer, Native Client)
3. `navigator.languages` → `["en-US", "en"]`
4. `navigator.permissions.query({name:"notifications"})` → returns `{state:"prompt"}` instead of `"denied"` (headless tell)
5. `window.chrome` → stub object with `runtime`, `loadTimes`, `csi`
6. `navigator.hardwareConcurrency` → 8
7. `navigator.deviceMemory` → 8
8. `navigator.platform` → matches UA (Windows → `"Win32"`, macOS → `"MacIntel"`)
9. `screen.width/height/colorDepth` → realistic (1920x1080x24)
10. `screen.availWidth/availHeight` → slightly less than full
11. WebGL `UNMASKED_VENDOR_WEBGL` / `UNMASKED_RENDERER_WEBGL` → realistic (`"Google Inc. (Intel)"` / `"ANGLE (Intel, Intel(R) UHD Graphics...)"`)
12. `chrome.runtime.PlatformOs` → matches platform
13. Native-function `toString` — make patched functions report as `[native code]`
14. `Notification.permission` → `"default"` (not `"denied"`)
15. Battery API presence (stub)
16. `MediaDevices.enumerateDevices` → returns non-empty device list (but no cameras/mics)
17. `Error.captureStackTrace` cleanup — strip puppeteer-ish stack frames
18. Remove `console.debug` CDP markers
19. `window.outerWidth/outerHeight` → match inner when headless
20. `Intl.DateTimeFormat().resolvedOptions().timeZone` — leave system value (don't lie; just make it consistent with IP)

**Implementation note:** these have to run BEFORE any site JS executes. `context.addInitScript()` is the correct mechanism. Order them into one script string to minimize injection overhead.

**Acceptance:**
- Fixture `/detection-test` — an HTML page with inline JS that checks each vector, returns JSON blob of results. Crawl it, verify all checks pass.
- Compatibility smoke: crawl `/` fixture — all existing tests still green.

---

## Execution order (each step is independently green-able)

1. `resource-block.ts` + wire into crawler + integration test. **Smallest, biggest user-visible win, ship first.**
2. `rate-limiter.ts` + unit test.
3. `stealth.ts` skeleton: UA pool, sticky host→UA, Sec-CH-UA derivation, Accept-Language defaults, `buildLaunchHeaders()` helper. Integration test via `/show-ua` fixture.
4. 429/Retry-After handling in `crawlPage` + fixture + integration test.
5. Extend `stealth.ts` with the 20 init-script patches. Fixture `/detection-test` + integration test.
6. CLI flags in `sidecar/src/index.ts`. Rust passthrough in `src-tauri/src/commands.rs`.
7. Full-suite run. Typecheck (Rust + all TS projects). All green = done.

## Risks / gotchas

- **Blocking stylesheets breaks LCP.** Only block stylesheets when `!captureVitals`. Already in the design above; don't forget.
- **Blocking images breaks og:image download.** When `downloadOgImage` is on, don't block via resourceType for images; or track the OG URL per-page and allow just that one. Simplest: when `downloadOgImage` is set, don't block images via the route handler — we only download after extraction anyway and currently fetch them via plain `fetch()`, not via the browser. So actually the OG bypass is already fine. Double-check during implementation.
- **Sticky UA crosses hosts in sitemap discovery.** Sitemaps are fetched via plain `fetch()`, not via the browser — pass the chosen UA for the origin. Same for robots.txt fetches.
- **CH-UA mismatch is a hard tell.** Never send `Sec-CH-UA` with a Firefox/Safari UA. Gate strictly.
- **Stealth patches compete with vitals init script.** Order: stealth first, vitals second. Both installed before navigation via `context.addInitScript()`.
- **Playwright sometimes logs `[intercepted]`** when routes abort — stderr noise; fine.
- **Test server port 5000** — our fixtures live there. New fixtures added in `sidecar/test-server/routes.ts`.
- **Integration tests share the test server.** Killing it mid-suite causes re-spawn; we saw flaky timing previously. Kill old server with `pkill -f 'test-server'` before running a fresh test that adds routes.
- **Don't run destructive git commands.** No rebase, no force push. Commit per logical step is fine IF the user asks. They haven't asked for commits this turn.
- **CLAUDE.md rule:** `lock_or_recover()` for Rust mutexes, no shell interpolation, `shell.sidecar("fera-crawler")` not `"binaries/..."`. Already compliant; don't regress.

## File inventory (new + modified)

**New:**
- `sidecar/src/resource-block.ts` — resourceType + host-pattern block predicate
- `sidecar/src/stealth.ts` — UA pool, Sec-CH-UA derivation, init-script patches, header builder
- `sidecar/src/rate-limiter.ts` — per-host rate limiter class
- `sidecar/tests/unit/rate-limiter.test.ts`
- `sidecar/tests/unit/stealth.test.ts` — UA pool selection, CH-UA derivation, platform mapping
- `sidecar/tests/integration/resource-blocking.test.ts`
- `sidecar/tests/integration/stealth-and-rate-limit.test.ts`
- `sidecar/test-server/fixtures/detection-test.html`

**Modified:**
- `sidecar/src/crawler.ts` — install route handler, install stealth init-script, derive UA per-host, install rate limiter acquire before goto, handle 429/503 retry
- `sidecar/src/types.ts` — new `CrawlConfig` fields: `rotateUa`, `perHostDelay`, `perHostConcurrency`, `blockResources`
- `sidecar/src/index.ts` — parse new CLI flags
- `sidecar/test-server/routes.ts` — `/show-ua`, `/rate-limit-test`, `/detection-test`
- `src-tauri/src/commands.rs` — pass through new params

## Definition of done

- All previous tests still pass (62/62 from last run).
- ~6 new tests pass (resource blocking, stealth, UA rotation, rate limiter, 429 retry, detection).
- `npx tsc --noEmit` clean in `sidecar/` and `mcp-server/`.
- `vue-tsc --noEmit` clean in `frontend/`.
- `cargo check` clean in `src-tauri/`.
- Manual smoke: crawl a real site (e.g. `example.com` or user's choice) with resource blocking on; observe faster page load times in the result data (`responseTime` reduced vs previous runs).

## Reordered — blocked by P0 Settings Architecture (2026-04-24 decision)

User decision: settings architecture must ship first. Stealth is now baseline (not a user-facing toggle). Profiles differ on extraction + enrichment, not on evasion. This plan's items still ship — but **each new setting lands directly into the schema from P0 instead of being bolted onto the current scattered config layer.** No code changes to this checklist until P0 is done.

When P0 lands, the integration looks like:
- `performance.blockResources` — schema entry, boolean, default true
- `performance.closeOnExtract` — schema entry, boolean, default true
- `advanced.stealth.overrideDefaults` — hidden under Advanced; default off
- `advanced.stealth.perHostDelay`, `advanced.stealth.perHostConcurrency` — visible only when override is on
- UA rotation, CH-UA derivation, init-script patches — **not user-visible settings**; internal stealth baseline
- 429/Retry-After handling — internal, always on

## Not in scope for today

- Rust HTTP fast-path crawler (next week).
- Commercial unblocker integration (P5+).
- Authoritative store in Rust / UI redesign (P4/P6 of `future-fera.md`).
- Proxy support (Tier 4 in the stealth stack).

## If something unexpected comes up

- A new dependency is needed: check `CLAUDE.md` dependency policy. Prefer stdlib/native; pin exact versions if adding. Commit `package-lock.json`.
- A test times out: check if the test server is stale (`pkill -f test-server` + re-run).
- Rust type errors: the new `capture_vitals` / generation patterns are already in `commands.rs`; match that style for the new params.
