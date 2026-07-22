# Fera — TODOs

Living backlog. **Everything is on `main`** now — the old
`harden/crawler-review-fixes` branch is identical to `main`, and the
2026-07-22 session committed directly to `main`. Sections below are grouped by
theme; each open item says what/where/why.

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

**The common tell:** a predicate that keys off a bare column being empty/NULL
(`title=''`, `canonical IS NULL`) is NOT status/resource-safe; one that keys off
a JSON value being `>0`/`=0` usually IS (non-HTML rows have no `seo_json` entry →
NULL, excluded). Standard fix for the unsafe ones: add
`AND resource_type='HTML' AND status>=200 AND status<300`.

_From the `db_query.rs` sweep (2026-07-22). Frontend-report + crawler-extraction
findings append below when those audits land._

- [ ] **HIGH — health `empty_h1` / `empty_title` count non-HTML + non-2xx**
      (`db_query.rs:739-740`). Same class as the duplicate fix, unfixed here. A
      JS/CSS/image row (no h1) and every 3xx/404/500 row inflate the "missing
      h1/title" HEALTH cards. Fix: gate each `SUM(CASE …)` on
      `resource_type='HTML' AND status BETWEEN 200 AND 299`.
- [ ] **HIGH — grid "Missing title/h1/h2/meta" (`missing_field`) ungated**
      (`db_query.rs:~291`). Drill-through counterpart of the above — flags every
      non-HTML resource + redirect/error row. Fix: same HTML+2xx gate on the
      content columns.
- [ ] **HIGH — "Missing canonical" (`canonical_state="missing"`) counts every
      non-HTML + non-2xx row** (`db_query.rs:370`, bare `canonical IS NULL OR
      canonical=''`). Every script/stylesheet/image + redirect/error flagged.
      Fix: `AND resource_type='HTML' AND status BETWEEN 200 AND 299`. (`self`/
      `cross` are already safe — they require canonical present.)
- [ ] **HIGH — "Missing structured data" (`structured_data="missing"`) counts
      every non-HTML + non-2xx row** (`db_query.rs:405-408`). Same shape. Fix:
      same HTML+2xx gate.
- [ ] **MEDIUM — health `avg_response_time` / `max_response_time` include
      errors/redirects** (`db_query.rs:741-742`). The "slowest page" MAX can point
      at a 500 block-stub; fast 3xx (50ms) deflate the average. Fix:
      `AVG(CASE WHEN status BETWEEN 200 AND 299 THEN response_time END)` + same
      guard on MAX (NULLs ignored by both aggregates).
- [ ] **DECISION — `issues_only` (Issues tab) empty-content ORs ungated**
      (`db_query.rs:247-249`). Non-HTML assets (empty title/h1/meta) dominate the
      Issues count. May be an intentional catch-all — decide: if unintended, wrap
      the three empty-content ORs in `AND resource_type='HTML' AND status<400`.
- [ ] **LOW/strictness — status-gate the JSON-keyed filters too**: `security_missing`
      (`:397`), `images_missing_alt` (`:413`), `h1_state="multiple"` (`:417`) are
      HTML-safe (JSON NULL excluded) but NOT status-gated — a 3xx that followed to
      content and recorded first-hop headers/JSON can slip in. Add
      `AND status BETWEEN 200 AND 299` only if you want strict 2xx semantics.
      Also `missing_og_image`/`has_og_image` (`:276-279`) rely on the frontend
      always pairing an HTML gate — fragile if reused elsewhere.

- [ ] **MEDIUM — SECURITY health card + grid Security filter count non-HTML +
      redirects** (`db_query.rs:743-746` `sec_html`/`sec_missing_*`; grid Security
      tab not in `HTML_ONLY_TABS`). CORRECTION to an earlier "already-correct"
      note: `auditSecurityHeaders(responseHeaders)` runs on EVERY response
      (`crawler.ts:918`), so a JS/CSS/image row DOES carry a `securityHeaders`
      object (its own response's) → `json_extract … IS NOT NULL`/`= 0` counts it.
      A 3xx row carries the destination's headers. So the health card (shipped
      2026-07-22) and the grid Security filter both inflate; ReportPanel's
      `securityIssues` is correctly HTML+2xx-gated (`ReportPanel.vue:143-152`) →
      **the three security views disagree.** Fix: gate all three the same
      (HTML+2xx).
- [ ] **META — grid filters and reports disagree.** The ReportPanel reports gate
      several metrics on `resourceType==='HTML'` (+2xx) while the equivalent grid
      filters / HEALTH aggregates don't (security above; `issues_only`/`missing_field`
      per the Rust sweep). Same site, same question, different answers depending on
      where you look. Whatever gate we pick must be applied consistently across
      grid filter + HEALTH aggregate + report for each metric.

_Confirmed already-correct (no action): `duplicate_field` (the fix),
`canonical_state` self/cross, status buckets, `aggregate_resource_types`._

**From the `crawler.ts` extraction sweep (2026-07-22) — root cause + the fix
decision.** `crawlPage` (`:750`) runs `page.goto` (follows redirects) +
`EXTRACT_SEO_SCRIPT` unconditionally, with NO content-type/HEAD pre-check, then
records the first-hop status (`:813`). Consequences:
- A **3xx row** stores title/h1/meta/canonical/wordCount/**contentHash**/
  structuredDataTypes/hreflang/imagesMissingAlt/outlinks/securityHeaders of its
  **destination**, under the redirect's URL + first-hop status.
- A **non-HTML resource** (anchor-discovered PDF/JS/CSS/image) is fully navigated
  and records empty title/h1/meta — and a text resource (JS/CSS opened in
  Chromium's source viewer) even gets a non-empty `wordCount` → a spurious
  `contentHash` that can group it in the body-dup report.

- [ ] **DECISION (Dave) — fix at the source vs. per-consumer.** Current state is
      whack-a-mole: the title-dup consumer got the 2xx gate, the body-dup consumer
      + HEALTH counts + grid filters did not, and each new consumer must re-remember
      the rule (one already forgot). **Audit recommendation: source-side blanking**
      — when `status` is not 2xx OR `resourceType !== 'HTML'`, blank the
      metric-feeding fields (title/h1/h2/meta/canonical/wordCount/contentHash/
      structuredDataTypes/imagesMissingAlt) at write time in `crawlPage`/`db_writer`.
      Every consumer (grid, HEALTH, reports) becomes correct at once and can't
      regress. **Tradeoff:** a 3xx/non-HTML row would then show a BLANK title in the
      DATA grid instead of the destination's title — some users like seeing the
      destination title as context on a redirect row. Alternative: keep raw content
      for *display* but stop it feeding metrics via one shared 2xx-HTML predicate
      reused by every consumer (more code, preserves the grid context). Pick one
      before fixing the individual items above — it decides whether they're ~15
      consumer-side gates or one source-side change.
- [ ] **Most-urgent standalone fix regardless of the decision:** gate
      `duplicateBodies` (`ReportPanel.vue:83-92`) on 2xx-HTML — it's the direct
      contentHash twin of the title-dup bug already fixed in Rust, and currently
      groups every redirect with its target as "identical content."

**From the `ReportPanel.vue` sweep (2026-07-22).** The JS reports run over the
full unfiltered `query_all_results` set, so they're the second home of this bug —
notably the duplicate REPORTS still have the exact bug the grid FILTER fix
(`bd182ff`) closed. Standard fix: gate the aggregation loop/filter on
`r.resourceType === "HTML" && r.status >= 200 && r.status < 300`.

- [ ] **HIGH — Duplicate Titles / Meta / H1 *report* groups redirects with their
      targets** (`ReportPanel.vue:67-76` `duplicatesBy`, rendered ~368-376). No
      status/resource gate — a 3xx row carries the destination's title/desc/h1, so
      redirect+target always form a false 2-member duplicate group. Same bug as the
      grid filter, still live in the "authoritative" duplicate report.
- [ ] **HIGH — Duplicate Body Content report groups redirects with targets**
      (`ReportPanel.vue:83-92` `duplicateBodies`). The redirect row's `contentHash`
      is the followed destination's hash → byte-identical to the target → every
      redirect pairs with its target as "Identical content." Fix: same 2xx-HTML gate.
- [ ] **MEDIUM — Hreflang report lists redirect rows with the destination's
      alternates** (`ReportPanel.vue:156-160` `hreflangPages`). 3xx inherits the
      destination's hreflang array → misattributed rows. Fix: add the 2xx-HTML gate.
- [ ] **MEDIUM — Images-Missing-Alt report lists redirect rows with the
      destination's images** (`ReportPanel.vue:163-168`). Redirect carries the
      destination's `imagesMissingAlt`/`missingAltImages`. Fix: add the 2xx-HTML gate.
- [ ] **LOW — Orphan / PageRank link graph includes redirect/error/non-HTML nodes**
      (`ReportPanel.vue:215-237` `linkGraph`). A 2xx page linked only via a
      redirecting URL (`http://x` → 301 → `https://x`) gets `inDegree=0` → falsely
      flagged orphan; redirect nodes also carry the destination's outlinks, distorting
      PageRank. Subtler — no clean one-liner; needs redirect-target resolution in the
      graph. Note: `orphanPages` already restricts its *output* to 2xx HTML.

_Confirmed already-correct reports (no action): Broken Links (3xx explicitly NOT
broken), Missing Metadata, Security, Structured Data, Directives, Sitemap Coverage
(status-aware), Non-Indexable (includes 3xx/4xx by design + labels the reason),
Page Speed (row's own first-hop timing). `gridFilter.ts`/`CrawlGrid.vue` have no
client-side miscomputation — they rely on the Rust 2xx enforcement above._

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
