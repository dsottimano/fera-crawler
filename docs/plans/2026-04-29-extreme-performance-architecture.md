# Extreme-performance architecture: database-owned data, health-first UX

**Status**: planned, not started
**Date**: 2026-04-29
**Driver**: WebKit's per-process memory guard killed the app at 4.4 GB during an 8.5k-row session; the goal is unlimited-scale crawls (millions of rows) with constant memory footprint, plus a UX where the user doesn't have to babysit the grid to know if the crawler is doing its job.

## The problem in one paragraph

Today the data lives in three places at once: SQLite (correct, source of truth), the JavaScript heap as `results.value` (wrong, full duplicate), and Tabulator's internal storage (wrong, third copy). On every crawl-result the data crosses the bridge between processes (sidecar → Rust → webview) carrying the full row, gets parsed into a JavaScript object, and is then sent BACK across the same bridge so JavaScript can write it into SQLite via a generic SQL plugin. Two unnecessary serialization trips per row, plus duplicate storage. At 1 million rows it's catastrophic; at 8.5k it nearly killed the app. Memory grows linearly with crawl size.

## The principle

> The database is the only source of truth. Everything else is a temporary view of part of it.

```
[ Sidecar ] ── results stream ──→ [ Rust process ]
                                       │
                                       ├── writes directly to SQLite (sqlx, native, microseconds/row)
                                       │
                                       └── emits LIGHT progress events ──→ [ Webview UI ]
                                           ("count, errors, capture rates")    │
                                                                               │
                                                                               └── pulls only what it
                                                                                   needs to display:
                                                                                   "page 5000–5050,
                                                                                    filter status≥400,
                                                                                    sort response_time DESC"
```

## What changes vs. today

| Today | Tomorrow |
|---|---|
| Frontend writes to SQLite via `tauri-plugin-sql` | Rust writes via `sqlx` directly. Frontend never writes crawl results. |
| Webview holds every row in memory | Webview holds ~500 rows: the visible page + small scroll buffer |
| Filtering / sorting in JavaScript over the in-memory array | SQL `WHERE` / `ORDER BY` on indexed columns |
| Each crawl-result event ships a full row across two bridges | Crawl-result events carry an aggregate snapshot (counts + capture rates), debounced ~500 ms |
| Default screen: data grid (Internal / External / etc. tabs over rows) | Default screen: **Health dashboard**. Data grid is a separate on-demand screen. |
| Memory grows linearly with crawl size | Memory is constant regardless of crawl size |

## What stays

- **SQLite**. Right tool. Indexed correctly, handles tens of millions of rows.
- **Vue + Tabulator**. Fine viewer when given the right amount of data.
- **Patchright sidecar in Node**. Stealth coverage matters more than the few hundred MB/s we'd save by rewriting in Rust.
- **Tauri**. Right tool for a desktop SEO crawler.

## Decisions locked in

| Choice | Pick |
|---|---|
| Top-level navigation | Two screens: **HEALTH** (default) and **DATA**. Top-level tabs in the header. |
| Default screen on every launch | HEALTH |
| Default screen when opening a saved crawl | HEALTH (it summarizes the saved crawl too) |
| Health card click-through behavior | **Replace** any current Data filter, not stack. Each click is a fresh question. |
| Data screen | Existing grid + column tabs (Internal/External/etc.) live under DATA. Loads only when opened. |
| Crawl-result events to webview | Aggregate snapshots only — never row payloads. Debounced ~500 ms. |
| Frontend grid mode | Tabulator "remote / ajax" — asks Rust for rows on scroll, hands SQL filter+sort state across |
| Memory target | App total ~400–650 MB regardless of crawl size |
| Filter/sort coverage | Every existing tab and search must map to a SQL query — bounded but not trivial |
| Live-count event cadence | **500 ms uniform** — fast enough to feel responsive, slow enough that each update is visually distinct, modest battery cost |

## Health screen (the default)

Cards, each answering one specific question the user worries about. Drawn from the user's actual concerns ("is the crawler doing what I told it to?"):

| Card | Indicator |
|---|---|
| **Crawl status** | Hero card. CRAWLING / STOPPED / COMPLETE. Count, errors, elapsed, ETA. |
| **Status code mix** | Stacked bar / pie over last N. Click drills into DATA filtered. |
| **Response times** | Sparkline of avg per minute. Trending up = rate-limiting kicking in. |
| **Capture rates** | One row per "thing we said we'd capture": og:image, each scraper rule, H1, title, meta description. "47/50 captured (94%)". Red when toggle is on but capture is near zero. |
| **Redirect chains** | "Avg depth 1.2, longest 7. 4% chained ≥3 hops." Click to drill into rows with redirects. |
| **Hosts** | Distinct hosts seen, hosts paused by block detector, hosts with anomalous capture rates. |
| **Indexability** | % indexable / noindex / nofollow. Catches "saving noindex pages by accident." |
| **Issues** | Action list. "Scraper rule 'price' captured 0/100 — selector may be stale." Click to fix or drill in. |
| **Block alerts** | The existing block-detector UI lives here, replacing the current top-of-page banner. |
| **Recent rows strip** | Last 10 results — tiny, just for pulse. Not the focus. |

Every card is one SQL aggregate query. The whole panel computes in milliseconds.

### Click-through deep-links

| Click on health | Lands in DATA with filter |
|---|---|
| 4xx slice of status mix | `WHERE status >= 400 AND status < 500` |
| Redirect chain card | `WHERE redirect_url != ''` |
| Scraper rule "price" 0/100 | rows where `scraper.price` is empty |
| Slow response card | `ORDER BY response_time DESC LIMIT 50` |
| Block alert host | `WHERE host = '<host>'` |

## Phases

### Phase 1 — Rust takes over writes (~2 days)

- New Rust module owns the sidecar's stdout NDJSON stream. Parses `crawl-result` lines once, writes a batched multi-row INSERT via `sqlx`.
- Delete the JavaScript-side batched-insert buffer and `doFlushInner` from `useDatabase.ts`.
- Frontend stops writing to `crawl_results`. Other tables (`crawl_sessions`, `profiles`, `crawl_configs`) stay frontend-managed for now.
- Verify: sidecar stream → SQLite, observed via direct DB query. Existing rows from prior crawls untouched.

### Phase 2 — Rust query commands (~1 day)

- New Tauri commands:
  - `query_results(session_id, page, limit, filter, sort)` → returns up to `limit` rows
  - `count_results(session_id, filter)` → total matching rows for paging math
  - `get_result_full(session_id, url)` → one row including `seo_json` parsed for detail view
  - `aggregate_health(session_id, last_n)` → one big SELECT computing every health card's value in a single query
- The `filter` and `sort` parameters are typed structures that map to SQL clauses (no raw SQL from the frontend).
- Verify: each command returns expected shape on a real session. Tests with fixture data.

### Phase 3 — Aggregate progress events (~1 day)

- Rust still listens to the per-result stream (it's writing them to DB), but the only event sent to the webview is a debounced `crawl-progress` ~500 ms snapshot: `{ rowCount, errorCount, lastUrl, latestStatuses }`.
- Block-detected and probe events stay row-specific (those are user-actionable and rare).
- Frontend stops listening to `crawl-result` per-row. Removes the `unlistenResult` handler.
- Verify: live count updates in the UI without per-row events flowing.

### Phase 4 — Grid switches to remote / windowed mode (~2 days)

- Tabulator config: `ajaxURL` style (or `pagination: "remote"`) — grid asks Rust for the page it needs.
- Filter / sort state translates to the typed `filter` / `sort` parameters in Phase 2's commands.
- Existing column tabs (Internal / External / Security / etc.) become preset filter values.
- Bottom panel detail view: calls `get_result_full` for the selected row.
- Live updates while crawling: refresh-on-scroll-near-bottom + manual "X new rows — refresh" indicator (low priority since user shouldn't need to live-watch the data anyway, that's what Health is for).
- Verify: every existing tab + every column sort + the search bar all return correct results from SQL. Tests with fixture data.

### Phase 5 — Health screen (~2 days)

- Top-level navigation: HEALTH | DATA tabs in the header. Default HEALTH.
- Card components, one per indicator above. Each card subscribes to the `crawl-progress` event during a crawl, or polls `aggregate_health` on demand for completed sessions.
- Issues-detection rules (the logic that flips a card from green→amber→red) — bounded set of thresholds. Initial set:
  - Capture rate <50% with toggle on → red
  - Average redirect depth >3 → amber, >5 → red
  - Empty-H1 rate >25% → amber
  - Status 4xx/5xx >10% in last window → amber
- Click-through plumbing: HEALTH cards emit a "drill into DATA with this filter" action that the parent handles by switching tabs and seeding the DATA filter state.
- Verify: each card renders correctly during a live crawl AND for an opened saved crawl.

### Phase 6 — Cleanup (~1 day)

- Delete the in-memory `results.value` array path entirely.
- Delete the lazy seo_json enrichment (`enrichSeo`) — the rows already have full seo_json in DB, the detail view fetches on demand.
- Delete `setDataPreservingScroll` and the addData/redraw watchers — Tabulator manages its own data now.
- Update tests: every test that previously asserted on `results.value` now asserts on a Tauri command or a DB query.
- Memory smoke test: 1M synthetic rows in a session, app stays under 600 MB total.

**Total: ~9 days end-to-end.**

## Memory targets

For ANY size crawl, in steady state:

| Process | Memory |
|---|---|
| Sidecar (Chromium + Patchright) | ~200–300 MB regardless of crawl size |
| Rust process | ~50–100 MB (sqlx pool, write buffer, aggregate counters) |
| Webview UI | ~150–250 MB (Vue + Tabulator + ~500 visible rows) |
| **Total app** | **~400–650 MB, flat** |

A 10 million-row crawl has the same memory footprint as a 100-row crawl. Disk is the only thing that scales with crawl size.

## Risks

1. **Filter / sort coverage**. The biggest risk is regression — every existing column sort and every filter tab needs an exact SQL equivalent. Mitigation: write the mapping table BEFORE Phase 4 starts; treat each row of the table as one test case.
2. **Live-update latency**. Aggregate events at 500 ms means the count updates feel slightly less "live" than today. Acceptable trade for the architectural win; if it feels sluggish during testing, drop to 200 ms.
3. **Crawl-result event removal might break BlockAlert / probe flow**. Audit those event subscriptions before Phase 3.
4. **Tabulator remote/ajax mode quirks**. The library supports it but our specific column setup might need tweaks. Bounded.
5. **Saved-crawl rehydration**. Currently `loadSession` populates `results.value`. After this work, "loading" a saved crawl is just setting `currentSessionId` — the grid pulls rows on demand. Simpler, but the rehydration logic from earlier (HMR survival) needs to adapt.

## What I would NOT change

- Don't migrate to a different database (no, DuckDB doesn't help this problem; that's offline analytics, separate feature).
- Don't switch UI frameworks. Vue is fine when given the right amount of data to manage.
- Don't replace Tauri.
- Don't try to make the sidecar Rust. Stealth coverage matters more.

## Definition of done

- A 1M-row synthetic crawl completes with app total memory under 600 MB at all times
- Health screen is the default; every card matches its threshold rules; click-through to DATA works for all listed cards
- DATA screen handles every existing column sort + every filter tab via SQL
- Frontend never writes to `crawl_results`. Frontend never holds more than ~500 rows in memory.
- All existing tests still pass; new tests cover the Rust query commands and health aggregates
- Saved-crawl rehydration still works post-refactor

## Open questions

None. Ready to execute.
