# Fera — TODOs

Remaining work after the code-review hardening + Screaming-Frog feature push
(branch `harden/crawler-review-fixes`). Every High/Medium review finding is
fixed except **M1** below; these are the larger/riskier/polish items that were
deliberately deferred.

A follow-on **crawler-resilience session (2026-07-21)** shipped headless-default,
the live-grid flicker fix, crawl re-adoption after a webview reload, the ERRORS
double-count fix, a one-click req-fail filter, the probe fast-track, **Chromium
proxy support**, and **VPNGate list fetch**. Its deferred items are the new
"Proxy / VPNGate / probe" section below.

## Bugs / architecture

- [ ] **M1 — reports load the full row set** (`db_query.rs:713` `query_all_results`,
      callers `ReportPanel.vue`, save/export). On very large crawls, opening a
      report pulls every row + full `seo_json` into the JS heap, breaking the
      flat-memory invariant. Proper fix = server-side SQL aggregation per report.
      Note: the graph reports (PageRank / Orphans / Broken Links) fundamentally
      need the whole link graph in memory (as Screaming Frog does), so this is a
      deliberate, larger initiative — decide per-report whether to aggregate in
      Rust or accept the in-memory model with a row cap + warning.

## Proxy / VPNGate / probe (2026-07-21 session)

Foundation shipped: Chromium proxy support (`connection.proxyServer/-Username/
-Password`, Connection tab, cross-OS + unprivileged) and VPNGate list fetch
(`vpngate_servers` Rust cmd → sidecar `vpngate` subcommand). Full design +
rationale in `docs/vpngate_integration.md`.

- [ ] **VPNGate tunnel (the blocker)**. Turning a chosen server into a live local
      SOCKS needs a rootless, cross-OS userspace OpenVPN→SOCKS bridge:
      **compile + bundle** patched `openvpn-tunpipe` (or `openvpn-tuna`) +
      `russdill/tunsocks` per OS, then a `vpn_connect(ovpn)`/`vpn_disconnect` Rust
      command that runs `openvpn --dev "|tunsocks -D <port>"`, waits for the SOCKS
      port, and sets `connection.proxyServer` to `socks5://127.0.0.1:<port>`. This
      is a CI/bundling task, not app code. Reality check: VPNGate exits are
      datacenter/volunteer IPs Akamai/DataDome blanket-block — good for
      geo-blocks/soft-rate-limits, weak vs. commercial WAFs (use a residential
      proxy via the Connection tab for those).
- [x] **Probe matrix ignores the proxy**. ~~`run_probe_matrix` → `probeMatrix.ts`
      `runRow` does NOT thread `connection.proxy*` into its `launchPersistentContext`.~~
      DONE (2026-07-22). Threaded `connection.proxy*` end-to-end: BlockAlert →
      `run_probe_matrix` (new proxy_* params) → sidecar `probe-matrix` flags →
      `runProbeMatrix`/`runRow` `launchPersistentContext.proxy`. The Rust-side
      auto-reprobe (`re-probe-requested`) reads the active crawl's proxy from
      new `ProbeState::crawl_proxy` (captured at `start_crawl`).
- [ ] **VPNGate picker UI**. Connection-tab list (country / score / speedMbps)
      calling `vpngate_servers`; on connect, drive `vpn_connect` (above). Not built
      — a picker with no working tunnel would be misleading, so deferred with it.
- [x] **Probe speed cuts** (offered, deferred). DONE (2026-07-22). `crawlPage` in
      `runRow` now passes `{ navTimeout: 10000 }` (was Chromium's 30s default), and
      headed rows cap their pre-request pause at 2.5s (`Math.min(perHostDelayMs,
      2500)` when `cfg.headed`). Together these shave most of the ~1min "all
      failed" probe.
- [ ] **Proxy password is stored plaintext** in the profile `config_json` (like
      every other setting). Add masking / secret handling if that's not acceptable.

## Crawl trust: queue visibility + repeat-on-resume

- [ ] **Surface the crawl queue (pending frontier)**. The pending set already
      lives in `crawl_frontier` (DB-backed, `get_frontier_urls` in `db_query.rs`),
      and HEALTH shows a NOT-CRAWLED count — but there's no way to *see the list*.
      Add a queue view (a grid tab or a panel) listing `crawl_frontier` URLs so
      the user can verify what's queued vs. crawled instead of trusting blindly.
      Wire a `query_frontier(sessionId, page, limit)` reader like `query_results`.
- [ ] **Investigate: URLs repeat on stop/resume** (user-reported, not yet
      root-caused). Leads, in order of suspicion:
      1. **Normalization drift across three paths.** A URL is keyed by `url` in
         `crawl_results`, in `crawl_frontier` (frontier prune = `DELETE … WHERE
         url IN (…)`, `db_writer.rs:341`), and in the resume skip set
         (`get_skippable_urls`). The sidecar normalizes via `normalizeUrl` before
         emit, and resume re-normalizes `excludeUrls` (`crawler.ts:1344`) — but if
         ANY path disagrees on canonical spelling (trailing slash, case, default
         port, fragment, sort of query params), the frontier prune misses → stale
         pending row re-seeded on resume, and/or the crawl_results DELETE-then-
         INSERT misses → a genuine **duplicate row**. Audit that all three key on
         one identical canonical form. This is the most likely cause of *visible*
         repeats.
      2. **Start URL re-crawled every resume (by design).** `crawler.ts:1350-1354`
         deletes the spider start URL from the visited/exclude set so link
         discovery can bootstrap — so the homepage is re-fetched on each resume.
         One URL, row replaced (not duplicated), but it IS a repeat; confirm it's
         only the seed and document it.
      3. **Frontier ↔ retryable overlap on re-seed.** Resume re-seeds
         `get_frontier_urls` + `get_retryable_urls` (`useCrawl.ts`); verify a URL
         that's in both (parked AND in frontier) can't be enqueued twice — the
         `depthOf` dedup should cover it, but confirm against the normalized key.
      Repro: crawl a site, STOP mid-crawl, RESUME, then check for duplicate `url`
      rows in `crawl_results` for the session and whether pages/sec re-processes
      already-done URLs.

## New extraction (each needs an `EXTRACT_SEO_SCRIPT` change in `sidecar/src/crawler.ts`)

- [ ] **Anchor text + rel on links** (sf-research #9). RISKY: today `outlinks` is
      `string[]` and the link-graph reports (`ReportPanel.vue` PageRank / orphans /
      broken-links) do `indexOf.get(link)` on those strings. Changing `outlinks`
      to `[{href, anchor, rel, follow}]` breaks them. Add a *parallel* anchors
      field (keep `outlinks: string[]`) or refactor all consumers together.
      Unlocks: anchor-text report + follow/nofollow segmentation.
- [ ] **Near-duplicate content (simhash)**. Exact-dup is done (`contentHash`,
      FNV-1a). True near-dup needs shingling/minhash over the visible text +
      a similarity-threshold grouping. Bigger.

## Polish / surfacing (data already persists — frontend/Rust only)

- [ ] **Core Web Vitals health card** on `HealthScreen.vue`. Columns + the Slowest
      Pages report exist; a summary card (avg TTFB, % poor LCP/CLS) needs a Rust
      aggregate over `perf` in `seo_json`. NOTE (2026-07-22): deferred vs. the
      Security card because LCP/CLS in `seo_json.perf` are 0 unless `captureVitals`
      was ON for the crawl — so "% poor LCP" would silently read 0% (looks great)
      on a crawl that never measured it. Needs a decision: gate the LCP/CLS rows on
      a "vitals captured" denominator (count pages with perf.lcp>0) and/or show a
      "vitals not captured" state. TTFB is always present (nav timing) so that row
      is safe. Ask Dave which behavior he wants before building.
- [x] **Security health card** on `HealthScreen.vue`. DONE (2026-07-22).
      `aggregate_health_inner` now emits `secHtml` (denominator = HTML pages that
      recorded a securityHeaders object) + `secMissingHsts/Csp/Xframe` via
      `json_extract(seo_json,'$.securityHeaders.*') = 0` (same paths as the grid's
      security filter). New SECURITY HEADERS card drills to the Security tab with
      `sec:hsts`/`sec:csp`/`sec:xframe`. Rust test
      `aggregate_health_counts_missing_security_headers`.
- [ ] **Hreflang return-link validation**. The hreflang column + report list
      alternates; SF's real value is confirming each alternate links back. Needs
      a cross-URL pass after the crawl.
- [ ] **Sitemap "in-sitemap-not-crawled"**. The Sitemap Coverage report covers
      crawled rows (in/out of sitemap, non-200-in-sitemap). Detecting URLs listed
      in the sitemap but never crawled needs the sitemap URL set persisted
      separately (not currently stored) and joined against the frontier.

## Known correctness notes (not bugs, worth surfacing to users)

- [ ] Only the FIRST `title`/`h1`/`h2` text is captured (`querySelector`);
      `h1Count`/`h2Count` now expose multiplicity, but the *text* columns show
      only the first. Fine for most uses; document it.

## Reference

Full history + rationale for what shipped is in the project memory
(`project_review_backlog_2026_07.md`; proxy/VPNGate stream in
`project_proxy_vpn.md` + `docs/vpngate_integration.md`). Nothing is merged to
`main` yet — the work lives on `harden/crawler-review-fixes`.
