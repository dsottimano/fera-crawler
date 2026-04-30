# Fera — Enterprise-Ready Plan

Captured from a "what would an enterprise SEO say if I handed them this today?"
review on 2026-04-29 (post-v0.4.2). Persona: someone who runs Screaming Frog
daily, manages ~10 monitoring crawls/week across client sites, exports to
BigQuery / Looker, and reports to stakeholders weekly.

## One-line verdict

**Crawler engine is enterprise-grade. Crawl-management workflow isn't yet.**
Fix Tier 1 + sign the Windows installer and colleagues will adopt; ship Tier 2
and teams pay for it.

---

## What works today (don't break these)

- **Data extraction completeness** — hreflang, structured-data @types, security
  headers, JS errors, failed subresources, console errors, multi-hop redirect
  chains, canonical, robots-headers, OG dimensions, dates. Superset of
  day-to-day SEO needs.
- **Anti-bot resilience** — 7-row probe matrix + per-host pacing + adaptive
  slowdown. Crawls hostile sites (Akamai, CF, DataDome) without manual fiddling.
  Genuinely better than Screaming Frog here.
- **Live ops feedback** — PAGES/SEC + ETA + queue + in-flight + phase chip on
  HEALTH. Screaming Frog has none of this.
- **Memory ceiling** — ~400-650 MB flat regardless of crawl size. Paged
  Tabulator + Rust-owned DB writes. Outlasts Screaming Frog at 500k+ URLs.
- **Block recovery UX** — Auto-probe + apply on first block is invisible until
  needed, then magic. Real time-saver on hostile sites.
- **Patchright stealth + per-host pacing** — load-bearing competitive moat;
  the architecture-decision memory documents why.

## Tier 1 — before declaring "ready for daily use"

### 1. Verify v0.4.2 actually installs + crawls on Windows

The v0.4.2 fixes (sharp drop, `windows_subsystem = "windows"`, NSIS pre-install
nuke) are correct in theory. None has been runtime-verified on a real Windows
box. This is the only thing left to know about Windows readiness.

**Verification path:**
1. Install on a clean Windows 10 / 11 box.
2. No cmd window pops on startup.
3. Start a crawl, watch HEALTH. PAGES counter increments → IPC works.
4. DEBUG → LOGS shows INFO entries (`crawler starting`, etc.).
5. og:image download works → check `%APPDATA%\com.fera.crawler\og-images\<sid>\`.
6. Reinstall over an existing v0.4.2 → confirm prior session list is wiped
   (NSIS hook fired).

**If (3) fails but (2) succeeds:** stdio pipes still aren't reaching node.exe.
Fall back to explicit `CREATE_NO_WINDOW` flag on the launcher's `Command::new`
of node.exe.

**If NSIS build fails on the macro:** `installerHooks` may need a different
shape in current Tauri NSIS bundler. Check the build log; the macro name
`NSIS_HOOK_PREINSTALL` was written from memory.

### 2. Diff-between-crawls view

The whole point of recurring crawls is regression detection. Sessions are
already in the DB. Currently zero UI surfaces "what changed."

**Spec:**
- New screen / report: "Compare with previous crawl"
- Pick two sessions (default: last two for the same start_url)
- SQL `JOIN ON url`:
  - **Added** — URLs in B not in A
  - **Removed** — URLs in A not in B
  - **Status changed** — `a.status != b.status`
  - **Title / H1 / canonical changed** — text diff
  - **Lost canonical / became noindex** — directive regressions
  - **Redirect chain grew** — `LENGTH(a.redirect_chain) < LENGTH(b.redirect_chain)`
- Each section is a CSV-exportable table.

**Why now:** medium effort, fully self-contained (no external deps), unlocks
the recurring-monitoring workflow even before #3 ships.

### 3. XLSX export with multi-sheet structure

Today: CSV with embedded JSON arrays in `metaTags` / `outlinks` /
`redirectChain` columns. Unusable in Excel without preprocessing.

**Spec:** new "Export Workbook" action producing one `.xlsx` with sheets:
- `Overview` — summary stats (counts by status, by resource type, etc.)
- `URLs` — main table, JSON cols dropped or moved to a separate sheet
- `Redirects` — flattened: `(from_url, hop_index, hop_url, hop_status)`
- `Outlinks` — flattened: `(source_url, target_url, internal_external)`
- `Issues` — prioritized issue list (depends on #5)
- `Duplicates` — duplicate-title groups
- `Hreflang` — flattened: `(url, lang, href)`

Implementation: `xlsx` (or SheetJS) lib. ~200 lines of glue.

### 4. Formula-injection sanitization on CSV/XLSX export

Standard fix in 3 lines:

```ts
function sanitizeCsvCell(s: string): string {
  if (/^[=+\-@]/.test(s)) return `'${s}`;
  return s;
}
```

Applied in `rowsToCsv` and the XLSX writer. Defends against a malicious page
title like `=HYPERLINK("http://evil/")`/RCE-via-Excel-macros payloads when a
crawled file is opened in Excel.

### 5. Code-sign the Windows installer

Non-engineering: every unsigned-installer install on Windows hits SmartScreen
("Windows protected your PC"). Acceptable for one engineer testing; not
acceptable for a colleague who's never seen the tool before.

**Options:**
- EV code-signing cert (~$300-500/year) → no SmartScreen warnings at all
- Standard cert (~$100/year) → reputation builds with downloads over weeks
- For now: document the SmartScreen click-through path in README

## Tier 2 — next month, after Tier 1 lands

### 6. GSC / GA4 / Ahrefs integration (single biggest absolute win)

Daily enterprise SEO workflow is "join crawl with impressions/clicks/
backlinks to find pages worth fixing." Without this, every report needs a
manual VLOOKUP in Sheets.

**Phased delivery:**
1. **GSC first** — biggest standalone value, OAuth, "join clicks/impressions
   per URL." Public Search Console API supports per-URL queries.
2. **GA4 second** — sessions/conversions/bounce per URL.
3. **Ahrefs / Semrush** — paid APIs, keyed in Settings.

**Where it shows up:**
- New columns in the data grid (lazy-fetched, can-cancel)
- New HEALTH cards: "Pages with traffic and noindex", "Pages with backlinks
  and 4xx" (the actual prioritization queries enterprise SEOs run daily)
- Issues prioritization (#7) becomes meaningful

**Scope warning:** OAuth flow + connector UI + per-source rate-limit handling
+ caching is bigger than it looks. Probably 2-3 weeks for GSC alone.

### 7. Scheduled crawls

Pairs naturally with the diff view (#2). "Run this crawl every Monday at 3am,
diff against last week's run, surface regressions on next launch."

**Spec:**
- Tray icon (Tauri supports it) so the app can run without window open
- Cron-like scheduler (existing crate: `croner` or similar)
- "Schedule this crawl" action on saved-session card
- Run at scheduled time → completion notification → "View regressions"
  one-click

**Headless-safe:** the crawler already runs detached from the UI; the work is
the scheduler + system-tray + auto-launch lifecycle.

### 8. Issues prioritization (impact ranking)

Today: Issues tab is `WHERE has_problem = true`. Senior SEOs want priority:
1. **Indexable-but-broken** — 2xx + canonical mismatch, 2xx + noindex header,
   2xx with title/H1 missing on a page with internal links
2. **Lost equity** — 4xx with internal inlinks > 0, redirect chain length > 3
3. **Cosmetic** — duplicate titles on noindexed pages, missing alt-text
4. **Information-only** — orphan HTML pages, soft-404 candidates

**Spec:** rules engine. Each issue rule has `(predicate, severity, message)`.
Pre-compute on insert into `crawl_results.issues_json` column, or compute on
read via SQL view. UI: Issues tab gains a severity column, default-sort by
severity desc.

## Tier 3 — later, lower marginal value

### 9. Bulk recrawl-with-overrides

"Recrawl every 4xx with `delay=5000` and `headless=false` to verify they're
not just blocked." Today it's not 1-click.

**Spec:** FilterBar gains a "Recrawl filtered with override…" action that
opens a small config delta modal.

### 10. Segment sampling

A 5M-URL e-commerce site can't be fully crawled. Need: "1k from /products/,
1k from /blog/, all from /". Today it's all-or-nothing.

**Spec:** inputs section gains a "sampling rules" textarea: `pattern: limit`
pairs.

### 11. Internal-link graph view

Inlink counts already exist in raw data (from `internal_links` /
discovered-links join). Surface as:
- Sort column on the grid: "Inbound internal links"
- Top-N list on HEALTH: "Most-linked-to pages" (link equity hubs)

(Real PageRank computation is a separate, larger project; the simple inlink
count is 80% of the value.)

### 12. Better CSV column shape (split multi-file export)

If #3 ships, this is largely subsumed. If not: emit a directory of CSVs
(`urls.csv`, `redirects.csv`, `outlinks.csv`, `hreflang.csv`) on bulk export.

## What looks like a gap but isn't

| | |
|---|---|
| Lighthouse / Core Web Vitals capture | Already in `captureVitals` (LCP/CLS/FCP). Just not surfaced prominently in UI. |
| robots.txt + sitemap.xml parsing | Both implemented (`robots.ts`, `sitemap.ts`). |
| Custom extraction rules | `scraperRules` already supported in CrawlConfig and ScraperModal. |
| Profile-per-config | `useProfiles` exists with duplicate/import/export — just not pre-loaded per domain. |

## What to consider dropping / de-emphasizing

- **15 category tabs** is too many. Internal / External / Issues / Recrawl +
  search covers 90% of usage. Tabs are mostly status-code or extension
  filters that FilterBar already handles.
- **Recrawl Queue tab** — has the right idea but feels half-finished. Either
  elevate to first-class workflow with a clear "drain queue" UI, or fold
  into FilterBar as a saved filter.

## Cross-cutting product polish

- **Settings: per-domain defaults.** Profiles exist; auto-pick by start-URL
  domain doesn't.
- **First-run experience.** Today: blank app, expects user to know what to
  do. Should default to a sample crawl (`https://example.com`) or a guided
  setup card.
- **Documentation site.** README is good; users will want a "how do I do X"
  searchable docs site eventually. Out of scope until Tier 1+2 ship.

## Open questions (pre-Tier-1)

1. Are colleagues OK with the per-install data wipe (NSIS pre-install nuke)?
   For SEO consultants who have meaningful crawl history, this is
   destructive. Maybe gate the wipe behind a "Clean install" checkbox in
   the installer, defaulted on but skippable.
2. What's the largest single-site crawl anyone has done with Fera? Need at
   least one 500k+ URL run logged before claiming "scales to enterprise."
3. Is there a target persona — solo SEO consultant, in-house team of 3-5,
   or 50+ person SEO agency? Tier-2 priorities shift heavily based on this.
