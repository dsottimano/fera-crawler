# Fera — TODOs

Living backlog. **Everything is on `main`** now — the old
`harden/crawler-review-fixes` branch is identical to `main`, and the
2026-07-22 session committed directly to `main`. Sections below are grouped by
theme; each open item says what/where/why.

---

## Shipped — 2026-07-30 session (4-agent full review of the working diff)

Reviewed the uncommitted scope/exporter/deep-capture work before landing it;
five blockers + six follow-ups fixed in `74460e1` and the commit after it.

- **Scope frozen before the seed redirect** — the base came from the *typed*
  URL, so a seed that 301s to another registrable domain put every link out of
  scope and the spider stopped after one page (`internalLinks: 0`). Now the
  seed's post-redirect URL is resolved once and `scopeArg.base` is rebased in
  place. Regression test uses a `localhost` → `127.0.0.1` fixture redirect and
  was confirmed to fail without the fix.
- **`crawling.discoverSitemap` was a dead toggle** — UI-only, with discovery
  actually gated on `respectRobots` (so robots-off silently killed sitemaps).
  Wired payload → `commands.rs` → sidecar as an opt-OUT flag; the robots cache
  is built for either consumer and only `respectRobots` may block a fetch.
- **`crawl_frontier` insert had no test** — the `VALUES` form SQLite rejects
  made every frontier write fail, and errors there are only `eprintln!`'d, so
  nothing persisted and resume had nothing to re-seed from. Test confirmed to
  fail on the old SQL with `near "(": syntax error`.
- **Bundle export aborted past 4 GiB** — `large_file` was never set and entries
  are `Stored`, so the raw CSV size tripped zip64.
- **Mid-export failure destroyed the previous export** — `File::create`
  truncated the destination up front. Both paths now stream into `.part`
  siblings and rename only after every stream finishes.
- **CSV formula injection** — crawled titles/meta/response headers reach cells
  verbatim; values leading with `=`/`+`/`-`/`@`/tab/CR are now apostrophe-
  prefixed, with numbers exempt so numeric columns stay numeric.
- **No UTF-8 BOM** — Excel on Windows mojibaked every non-ASCII title.
- **`bytesWritten` always 0** for CSV exports; now summed from the finalized
  files. Duplicate `Done` event from `run_csv_export` removed.
- **Headed crawl minimized its window** — hidden renderers throttle timers and
  rAF, so LCP/CLS could never fire and rAF-gated content didn't render before
  extraction; it also hid the captcha headed mode exists to let you solve.
  Window now stays visible (Dave's call).
- **Test-integrity fixes** — `tests/helpers.ts` counted `event`-discriminated
  lines as crawl results; `scope.test.ts` tested a hand-copied duplicate of
  `_inScope` (now compiles the shipped `IN_SCOPE_SRC`, confirmed to catch a
  loosened predicate); `redirectHeaders`/`blockedByRobots` had zero assertions
  despite being the diff's actual bug fixes; a `?? {}` fallback masked the
  regression its own test existed to catch.

## Open — from the 2026-07-30 review (not yet done)

- **Blocking I/O on the tokio runtime** (`exporter.rs` row loop + og-image
  walk, called straight from `#[tauri::command] async fn`). A multi-GB image
  walk pins a worker for minutes and stalls the DbWriter flush during a live
  crawl. Real fix = split the sqlx row stream from the blocking file/zip writes
  (channel between an async reader and a `spawn_blocking` writer), plus `Send`
  bounds on `write_stream`'s writer and progress callback. Deliberately not
  bundled with the `.part`/4-GiB work — wants its own pass.
- **Companion CSVs overwrite without a prompt.** The save dialog confirms one
  path; `-outlinks` / `-failed-requests` / `-console` are written beside it. The
  `.part` work protects the *failure* case only — a successful export still
  clobbers same-named files.
- **Export progress counter resets per stream.** `write_stream` starts a fresh
  `ExportProgress` per call with the same `on_progress`, so the UI climbs 0→N
  four times; `discover_schema` takes no callback at all, so the whole first
  pass shows nothing.
- **`flat_record` is O(n·m) with a `String` alloc per comparison** — ~40 headers
  × ~40 columns ≈ 1600 `to_lowercase()` allocs per row (~1.6B on a 1M-row
  crawl). Pre-build one lowercased map per row.
- **`host` scope still drifts on redirect.** It resolves to "same host as the
  page landed on", so a page that 301s to `cdn.partner.com` makes that host's
  links internal — the exact bug fixed for `domain` scope, left for `host`.
- **Scope applies in list mode**, anchored to `urls[0]`, while the UI hides the
  Scope row for list mode and describes it as spider-only. A mixed-host URL list
  gets `internal=0` on most rows.
- **Sitemap seeding ignores scope** — only URLs whose origin exactly matches the
  seed are enqueued, so under `domain` scope sibling-subdomain sitemap URLs are
  dropped at seed time and arrive only via links. Nothing logs the rejected
  count.
- **`www.`-only stripping in `scopeBaseFor`** — seeding `it.babbel.com` gives
  base `it.babbel.com`, so `www.babbel.com` reads as external, contradicting the
  help text's "covers every subdomain of the seed".
- **Two headers differing only in case collapse** — `discover_schema` lowercases
  into one column but `flat_record` uses `.find()`, so `X-Cache` + `x-cache`
  exports one value and drops the other (the meta path joins instead).
- **`redirectChain` drops the destination when the chain revisits a URL**
  (A→B→A yields `[A, B]`), breaking the origin→destination invariant.
- **`--scope` has no end-to-end test** — flag parsing, Rust forwarding, and
  classification under domain scope are all untested; a flag-name typo on
  either side ships green. Same for `discoverSitemap` (the localhost fixture
  serves no sitemap, so a meaningful test needs a fixture sitemap first).
- **`jsErrors` has zero real coverage** — the one test is `it.skip`'d on a
  documented Patchright limitation (no `Runtime.enable`).
- **`performance.closeOnExtract` is still a dead setting** (known, pre-existing).

---

## Shipped — 2026-07-22 session

- **Probe: threaded the proxy** end-to-end (BlockAlert → `run_probe_matrix`
  proxy params → sidecar flags → `runRow` launch; Rust auto-reprobe reads
  `ProbeState::crawl_proxy`). Was testing DIRECT egress regardless of config.
- **Probe: speed cuts** — `crawlPage` runs `navTimeout:10000` (was 30s); headed
  rows cap the pre-request pause at 2.5s.
- **Probe: launch with the crawler's stealth args** (`0d20468`). The probe
  launched with NO `STEALTH_ARGS`/`ignoreDefaultArgs`, so every row ran with
  `navigator.webdriver=true` + the automation banner ON — far more detectable
  than the real crawl. It falsely reported "all blocked" on sites the user's own
  browser loads (babbel.com). Now mirrors `crawler.ts buildLaunchOpts` + a
  kill+retry on transient `browserContext…` launch errors. Residual gap if it
  still blocks: bundled Patchright Chromium v130 vs the user's Chrome/Brave 140+.
- **Security health card** on HealthScreen — `aggregate_health_inner` emits
  `secHtml` + `secMissing{Hsts,Csp,Xframe}`, drills to the Security tab.
- **Crawl realism: unified headed/headless pacing + human interaction**. Headed
  no longer forces 1 tab (`effectiveConcurrency = config.concurrency`, opens N
  tabs). New `sidecar/src/humanize.ts` — 2–4 mouse moves, 1–2 scrolls, 400–1500ms
  dwell/page, both modes, gated by `performance.humanize` (default ON), NOT in the
  probe. The per-host limiter always governed both modes — headed was never
  actually bypassing delays.
- **Grid: killed the "Loading" overlay + live-crawl jank** (`3417e91`).
  `dataLoader:false`, `layoutColumnsOnNewData:false` (freezes column widths so
  live ticks don't re-jitter), `progressiveLoadScrollMargin 300→800`, and
  `liveReload` uses `replaceData()` (silent — no loader, no scroll reset) instead
  of `setData()`. *Verify feel during a live crawl — couldn't headless-test.*
- **Duplicate title/desc/H1 ignores 3xx redirects** (`bd182ff`). The Duplicate
  filter matched value equality across ALL rows; a 3xx redirect carries its
  destination's title (crawler follows the redirect for content, records
  first-hop status), so a redirect + its 200 target always looked duplicate.
  Gated the self-join on 2xx both sides (Screaming Frog behavior). Test added.
  **This was one instance of a broader class — see the audit section below.**

---

## Open — data correctness (status / redirect / resource-type aware)

The duplicate-vs-redirect bug (`bd182ff`) revealed a class: a filter / health
aggregate / report computes a metric over rows it shouldn't, because it doesn't
gate on HTTP status, redirect, or `resource_type`. Root cause: a 3xx redirect
row carries its *destination's* content (title/h1/meta/canonical/wordCount/
contentHash/…) while keeping the first-hop status, and non-HTML resources still
get empty extraction fields.

**MOSTLY FIXED (2026-07-22, `63e36c4`) — source-side blank + missing-metric
gates.** Dave chose the source-side strategy. Implemented in two halves:
(1) `db_writer::blank_non_content_metrics` blanks metric fields on every
non-2xx / non-HTML row at the single write path — fixes all "has X"/"duplicate
X" consumers at once (dup title/body reports, dup/multiple-h1/has-SD grid
filters, security health card + grid Security filter, hreflang & images-missing-
alt reports). (2) `db_query` gates the "missing X" family on a shared
`CONTENT_PAGE` predicate (blanking can't fix counts-of-emptiness): `empty_h1`/
`empty_title`, `missing_field`, `canonical=missing`, `structured_data=missing`,
`issues_only`, `og_image`, and avg/max response-time. All items below that were
checkboxes are now covered — only the graph-topology item remains.

**Fixed by `63e36c4`** (source-side blank in `db_writer` + `CONTENT_PAGE` gates
in `db_query`), verified by the 3-way audit:
- Duplicate title/meta/h1 + duplicate-body REPORTS (`ReportPanel` `duplicatesBy`
  / `duplicateBodies`) — blanked fields drop out of their `if(!key)continue`
  guards; no frontend change needed.
- Grid duplicate / multiple-h1 / has-structured-data / has-og-image filters.
- Security health card + grid Security filter (securityHeaders→null → excluded;
  the "three security views disagree" issue is resolved — all now HTML+2xx).
- Hreflang + images-missing-alt reports (arrays→[] → excluded).
- "Missing X" family gated: `empty_h1`/`empty_title` health, `missing_field`,
  `canonical=missing`, `structured_data=missing`, `issues_only`, `og_image`.
- avg/max response-time gated on 2xx (slowest-page card can't show a block stub).

_Already-correct, untouched: Broken Links (3xx not broken), Missing Metadata /
Security / Structured Data / Directives / Sitemap Coverage reports (already
HTML+2xx-gated), Non-Indexable (includes 3xx/4xx by design), status buckets,
`aggregate_resource_types`._

- [ ] **LOW — Orphan / PageRank link graph includes redirect nodes**
      (`ReportPanel.vue:215-237` `linkGraph`). A 2xx page linked only via a
      redirecting URL (`http://x` → 301 → `https://x`) gets `inDegree=0` → falsely
      flagged orphan; redirect nodes also carry the destination's outlinks,
      distorting PageRank. NOT fixed by the blanking pass — needs redirect-target
      resolution in the graph (resolve each edge's URL through the redirect chain
      before counting in-degree), not a status gate. `orphanPages` already
      restricts its *output* to 2xx HTML, so the blast radius is a subset of
      orphan false-positives on sites with internal redirects.

---

## Open — bugs / architecture

- [ ] **M1 — reports load the full row set** (`db_query.rs` `query_all_results`,
      callers `ReportPanel.vue`, save/export). On very large crawls, opening a
      report pulls every row + full `seo_json` into the JS heap, breaking the
      flat-memory invariant. Proper fix = server-side SQL aggregation per report.
      The graph reports (PageRank / Orphans / Broken Links) fundamentally need the
      whole link graph in memory (as Screaming Frog does), so this is a larger
      initiative — decide per-report whether to aggregate in Rust or accept the
      in-memory model with a row cap + warning.

---

## Open — proxy / VPNGate

Foundation shipped 2026-07-21: Chromium proxy support (`connection.proxyServer/
-Username/-Password`, Connection tab, cross-OS + unprivileged) and VPNGate list
fetch (`vpngate_servers` → sidecar `vpngate`). Design in
`docs/vpngate_integration.md`.

- [ ] **VPNGate tunnel (the blocker)**. Turning a chosen server into a live local
      SOCKS needs a rootless, cross-OS userspace OpenVPN→SOCKS bridge: compile +
      bundle patched `openvpn-tunpipe` (or `openvpn-tuna`) + `russdill/tunsocks`
      per OS, then a `vpn_connect(ovpn)`/`vpn_disconnect` Rust command that runs
      `openvpn --dev "|tunsocks -D <port>"`, waits for the SOCKS port, and sets
      `connection.proxyServer` to `socks5://127.0.0.1:<port>`. A CI/bundling task.
      Reality check: VPNGate exits are datacenter/volunteer IPs Akamai/DataDome
      blanket-block — good for geo-blocks/soft-rate-limits, weak vs. commercial
      WAFs (use a residential proxy via the Connection tab for those).
- [ ] **VPNGate picker UI**. Connection-tab list (country / score / speedMbps)
      calling `vpngate_servers`; on connect, drive `vpn_connect`. Deferred with
      the tunnel — a picker with no working tunnel would mislead.
- [ ] **Proxy password stored plaintext** in the profile `config_json` (like
      every other setting). Add masking / secret handling if not acceptable.

---

## Open — crawl trust: queue visibility + repeat-on-resume

- [ ] **Surface the crawl queue (pending frontier)**. The pending set lives in
      `crawl_frontier` (`get_frontier_urls`), and HEALTH shows a NOT-CRAWLED
      count — but there's no way to *see the list*. Add a queue view listing
      `crawl_frontier` URLs. Wire a `query_frontier(sessionId, page, limit)`
      reader like `query_results`.
- [ ] **Investigate: URLs repeat on stop/resume** (user-reported, not root-caused).
      Leads, most-suspected first:
      1. **Normalization drift across three paths.** URL keyed in `crawl_results`,
         in `crawl_frontier` (prune = `DELETE … WHERE url IN (…)`,
         `db_writer.rs:341`), and in the resume skip set (`get_skippable_urls`).
         Sidecar normalizes via `normalizeUrl`; resume re-normalizes `excludeUrls`
         (`crawler.ts:1344`). If ANY path disagrees on canonical spelling (trailing
         slash, case, default port, fragment, query-param order), the frontier
         prune misses → stale pending re-seeded, and/or the DELETE-then-INSERT
         misses → genuine duplicate row. Audit all three key on one canonical form.
      2. **Start URL re-crawled every resume (by design).** `crawler.ts:1350-1354`
         deletes the spider start URL from the exclude set to bootstrap discovery
         — homepage re-fetched each resume. Row replaced not duplicated, but it IS
         a repeat; confirm it's only the seed and document.
      3. **Frontier ↔ retryable overlap on re-seed.** Resume re-seeds
         `get_frontier_urls` + `get_retryable_urls`; verify a URL in both can't
         enqueue twice — `depthOf` dedup should cover it; confirm on normalized key.
      Repro: crawl, STOP mid-crawl, RESUME, check for duplicate `url` rows and
      whether pages/sec re-processes done URLs.

---

## Open — new extraction (needs an `EXTRACT_SEO_SCRIPT` change)

- [ ] **Anchor text + rel on links** (sf-research #9). RISKY: `outlinks` is
      `string[]` and the link-graph reports do `indexOf.get(link)` on those
      strings. Changing to `[{href, anchor, rel, follow}]` breaks them. Add a
      *parallel* anchors field (keep `outlinks: string[]`) or refactor all
      consumers together. Unlocks anchor-text report + follow/nofollow segments.
- [ ] **Near-duplicate content (simhash)**. Exact-dup is done (`contentHash`,
      FNV-1a). True near-dup needs shingling/minhash over visible text + a
      similarity-threshold grouping. Bigger.

---

## Open — polish / surfacing (data already persists — frontend/Rust only)

- [ ] **Core Web Vitals health card** on HealthScreen. Columns + Slowest Pages
      report exist; a summary card (avg TTFB, % poor LCP/CLS) needs a Rust
      aggregate over `perf` in `seo_json`. NOTE: LCP/CLS are 0 unless
      `captureVitals` was ON, so a naive "% poor LCP" reads 0% (looks great) on a
      crawl that never measured it. Needs a decision: gate LCP/CLS on a "vitals
      captured" denominator (count `perf.lcp>0`) and/or a "not captured" state.
      TTFB is always present. Ask Dave before building.
- [ ] **Hreflang return-link validation**. The hreflang column + report list
      alternates; SF's real value is confirming each alternate links back. Needs a
      cross-URL pass after the crawl.
- [ ] **Sitemap "in-sitemap-not-crawled"**. Sitemap Coverage covers crawled rows;
      detecting URLs listed in the sitemap but never crawled needs the sitemap URL
      set persisted separately (not currently stored) and joined against the frontier.

---

## Known correctness notes (not bugs — worth documenting to users)

- [ ] Only the FIRST `title`/`h1`/`h2` text is captured (`querySelector`);
      `h1Count`/`h2Count` expose multiplicity, but the *text* columns show only
      the first. Fine for most uses; document it.

---

## Reference

History + rationale in project memory: `project_review_backlog_2026_07.md`,
`project_proxy_vpn.md`, `reference_probe_matrix.md`, `feedback_anti_bot_stack.md`,
`docs/vpngate_integration.md`.
