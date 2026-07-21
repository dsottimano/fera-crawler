# Fera — TODOs

Remaining work after the code-review hardening + Screaming-Frog feature push
(branch `harden/crawler-review-fixes`). Every High/Medium review finding is
fixed except **M1** below; these are the larger/riskier/polish items that were
deliberately deferred.

## Bugs / architecture

- [ ] **M1 — reports load the full row set** (`db_query.rs:713` `query_all_results`,
      callers `ReportPanel.vue`, save/export). On very large crawls, opening a
      report pulls every row + full `seo_json` into the JS heap, breaking the
      flat-memory invariant. Proper fix = server-side SQL aggregation per report.
      Note: the graph reports (PageRank / Orphans / Broken Links) fundamentally
      need the whole link graph in memory (as Screaming Frog does), so this is a
      deliberate, larger initiative — decide per-report whether to aggregate in
      Rust or accept the in-memory model with a row cap + warning.

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
      aggregate over `perf` in `seo_json`.
- [ ] **Security health card** on `HealthScreen.vue`. Columns + filters + report
      exist; a card (counts missing HSTS/CSP/X-Frame) needs a Rust aggregate over
      `securityHeaders`.
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
(`project_review_backlog_2026_07.md`). Nothing is merged to `main` yet — the
work lives on `harden/crawler-review-fixes`.
