# future-fera

Living plan — the next-era direction for the Fera crawler.

## Thesis (user, 2026-04-24)

> SEOs are mainly non-technical. They don't understand HTTP, servers, or how black-box ranking systems actually work. The industry runs on dogma: thought-leader tooling prescribes "fixes," the herd follows, devs implement without benchmarking. Google is opaque. Changes are rarely tested for impact.
>
> Humans cannot meaningfully ingest crawl-scale data — at best we spot-check. LLMs can. Fera should therefore be a **data machine**: over-collect, expose richly to Claude Code via MCP, let the model make decisions.
>
> Counter-risk: humans are trusting LLMs uncritically. We must not build a system where an LLM claim becomes truth without verification hooks.

## Agreed directional shifts (from preceding conversation)

| Prior assumption | Shift |
| --- | --- |
| AI analyst ships as a Tauri command with the user's API key | No. Claude Code is already the analyst. Fera's MCP server is the product surface for AI. No key handling, no egress cost. |
| Every `CrawlResult` column persists to SQLite indefinitely | No. Current schema blows up disk on large crawls (full `responseHeaders`, `outlinks[]`, `metaTags[]`, og-image `.webp` files). Needs layered retention + compression + opt-in expensive fields. |
| UI keeps growing columns per new data type | No. Grid-first IA is Screaming Frog copy-paste. New data (redirect chains, hreflang graphs, third-party inventory, CSP violations, JS errors) does not fit row-per-URL. UI rethink required before more feature columns ship. |

## Claude's feedback

### 1. Collect the whole HTTP envelope, not just derived SEO fields
What SEO tools skip but AI can exploit:
- Raw request/response headers (both directions), not just the five we audit.
- Resource timing breakdown: DNS, TCP, TLS, TTFB, download — not just `responseTime`.
- Third-party request inventory per page (trackers, ad nets, CDNs, fonts) with sizes and timings.
- Cookie + localStorage + IndexedDB footprint per domain.
- Service worker presence, cache strategy, precached URLs.
- CSP violations observed at runtime.
- Connection reuse: HTTP version, H2 push, Alt-Svc.
- Content hashes per resource for change detection across crawls.

These are cheap at capture time (Playwright sees them anyway via CDP) and are the substrate every interesting downstream question needs.

### 2. Provenance is the anti-hallucination primitive
Every MCP tool response must include row/observation IDs. Claude should be required to cite IDs with every claim. The UI resolves IDs → raw observed data. Mismatch = flagged. This is the firewall against "LLM said so, therefore true."

Every Fera-produced claim should be refutable against the stored bytes.

### 3. MCP tools must be faceted, not bulk
Current `get_crawl_data(filter, fields, limit, offset)` is a generic paginator — fine for a human, useless at scale. What Claude actually needs:
- `find_pages_where({ status: [4xx], lcp_gt: 2500, missing_header: "strict-transport-security" })`
- `group_by({ template: "canonical_base", agg: "count" })`
- `diff_pages(url_a, url_b)` — field-level diff with provenance
- `random_sample({ n: 20, where: {...} })` — representative sampling for expensive drill-down
- `raw_exchange(observation_id)` — returns the full captured HTTP bytes
- `hreflang_reciprocity()` — graph query: which `rel=alternate` pairs do not reciprocate
- `redirect_loops()`, `canonical_conflicts()` — precomputed graph queries
- `template_cluster()` — group pages by DOM skeleton fingerprint so Claude reasons per-template, not per-URL

Response envelopes stay small (schema + ID pointers). Agent drills down.

### 4. Storage as a negotiated resource
- Layered retention: recent N crawls = full fidelity, older = compressed delta snapshots, evictable oldest-first.
- Column-level opt-in for expensive fields (`responseHeaders`, `outlinks`, raw bodies, og-image binaries).
- Quota + storage-usage view in UI.
- MCP tools to introspect + rotate: `storage_stats()`, `purge_older_than(days)`.
- Consider DuckDB or SQLite + columnar (Parquet) split for the raw-exchange side vs derived-field side.

### 5. SEO blind spots worth instrumenting
Areas where the industry has no tooling and Fera-plus-Claude could be uniquely useful:
- Soft-404 detection (200 status, 404-like DOM signals).
- Canonical / og:url / sitemap-loc three-way conflict detection per URL.
- hreflang reciprocity + cluster completeness.
- Per-template drift across crawls (did the article template change? which pages diverge from the cluster?).
- Cookie-free/TLS-only reachability audit.
- Third-party dependency budget per template.
- CWV variance per template (is the LCP outlier a one-off or systemic?).

### 6. UI as verification layer, not analytics surface
- Primary loop: user asks Claude Code a question → Claude returns claim + ID set → user clicks claim in Fera UI → sees raw evidence → confirms or refutes.
- Claude's analyses become first-class, persisted objects. User annotations (confirm / refute / "needs engineer") attach to them. Over time this becomes a training signal — which LLM claims held up, which did not.
- Grid view becomes one of many saved views, not the default. View builder allows Claude-suggested queries to be pinned.
- Crawl-diff becomes a view, not a feature — "show me pages where X changed between these two snapshots."

### 7. Anti-trust-scaffolding
Design decisions that keep the human sharp:
- Show confidence + sample size on every LLM-generated claim.
- Make disagreement cheap: one-click "this is wrong, here's why" writes back to the session log.
- Occasionally surface "Claude said X, raw data says Y" diffs when they diverge.
- Never auto-apply fixes to anything. Fera recommends; user decides; developer implements.

## Open questions

- Storage backend: keep SQLite-only, or split (SQLite for metadata/derived + object store or Parquet for raw bodies and exchanges)?
- Is the `mcp-server/` codebase the right home for the faceted tool surface, or do those tools live in the Rust backend and the MCP server is a thin adapter?
- How much of the "verification UI" is new vs reuses the existing grid/panel components?
- Retention defaults: what's the out-of-box quota (assume consumer laptop, ~50 GB free is luxury)?
- Does Fera open-source the MCP tool schema so other agents (Cursor, Cline, custom) can consume it?

## Refinements (user + Claude, 2026-04-24)

### A. Storage: zstd with trained dictionaries
Agree with user — raw-envelope capture needs aggressive compression or storage explodes. Direction:

- **Content-addressed object store** for raw exchanges (request+response headers, decoded bodies). Hash-keyed; identical template responses stored once.
- **zstd with a trained dictionary**: train once on a sample of the user's own crawled bytes, store dictionary versioned alongside the store. HTTP headers + HTML compress ~4–6× at level 3 vanilla; with a domain-trained dictionary, 10–20× on repetitive template responses.
- SQLite keeps metadata + `content_hash` pointers. Object store is the heavy bucket.
- Decompression cost acceptable because we only hit raw bytes on drill-down queries, not on bulk scans (which we're avoiding by design).
- Dictionary versioning matters: keep old dictionaries for old crawls. Re-training cadence tied to retention tiers.
- Rust crate `zstd` + Node `@mongodb-js/zstd` both support dictionary mode. No custom work.

Open: Parquet/columnar for derived fields, or stay SQLite? Leaning stay-SQLite with a sidecar object store for raw exchanges — simpler ops story.

### B. Anti-hallucination: flip the frame
User is right that tools alone don't eliminate hallucination. The stronger reframe:

- Don't have Claude **produce claims then verify**. Have the MCP tool outputs **be** the deterministic answers. Claude's job becomes narration of tool results, not fact generation.
- Tool surface: `find_pages_where`, `count_where`, `group_by`, `diff_pages`, `hreflang_reciprocity`, `canonical_conflicts`. Every tool runs a strict-typed parametric query and returns rows + counts + observation IDs. The number in the response came from SQL, not from the model.
- Hallucination surface shrinks from "facts" (unbounded) to "narration" (bounded to the tool output). Much smaller attack surface.
- Belt and suspenders: a `verify_claim(structured_claim)` tool as backstop. Claim shape: `{natural_language: "...", verification: {kind: "count", where: {...}, expected: N}}`. Runs the query deterministically, returns pass/fail + observed. Used by the UI to re-check any extrapolation Claude makes beyond raw tool output.

### C. Structured queries + generative UI
User calls out that Claude shouldn't scan millions of rows — it writes structured queries. And the answer to the human shouldn't be prose, it should be a rendered UI.

- Claude returns a typed **widget spec** per answer, not markdown. Small fixed registry, versioned:
  - `{kind: "count", value, label, provenance}`
  - `{kind: "bar_chart", series, x_axis, y_axis, provenance}`
  - `{kind: "table", columns, rows, provenance}`
  - `{kind: "url_list", urls[], drill_in: "raw_exchange", provenance}`
  - `{kind: "diff", left, right, fields_changed, provenance}`
  - `{kind: "graph", nodes, edges, provenance}` (for hreflang, link graph, redirect chains)
- Widget schema is itself exposed as an MCP resource — Claude reads its own rendering palette.
- Every widget carries `provenance: {query: {...}, observation_ids: [...]}`. One click drills into raw bytes.
- Frontend becomes a renderer registry — `WidgetRenderer.vue` dispatches on `kind`. No hand-built panels per feature.
- Saved widgets (user-pinned) become the "dashboard." Claude builds the dashboard by authoring widgets; user curates.

This collapses the UI rethink problem: the UI is the widget renderer + the raw-bytes inspector + the claim-annotation log. Everything else is generated.

## Architecture direction (2026-04-24)

User framing: human must be able to use Fera without AI; AI is where the real value is (setup + post-crawl insights); UI is clunky; willing to rewrite to Rust.

### Claude's honest take

Don't conflate two different bottlenecks.

**Crawl performance:**
- Browser-driven crawl (Playwright/chromiumoxide): Chromium IS the bottleneck. Rust-vs-Node driver choice buys ~10% memory, 0% speed. Wrong battle.
- HTTP-only crawl (no JS render): Rust `hyper` + `scraper` is 10–50× faster than Node-through-browser. Right battle. Most real SEO crawls don't need JS rendering.

**UI performance:**
- Vue is not the bottleneck. The bottleneck is: unbatched streamed events, Tabulator re-rendering everything, heavy computeds on large arrays in the render thread, nothing in a web worker, aggregation done in JS that should be done in SQL.
- Rust UI frameworks (egui, Dioxus, Slint, Iced, Floem) cost months of rewrite and lose the web ecosystem (charts, graph libs, code editors, virtualized tables) for marginal main-thread gains. Wrong battle.
- Generative-UI direction from prior section is much easier to evolve in a web renderer than in a Rust GUI framework.

### Recommended layer split

| Layer | Language | Rationale |
| --- | --- | --- |
| **Fast HTTP crawler (new)** | Rust | `hyper`+`reqwest`+`html5ever`+`scraper`. Default mode. 10–50× on non-JS crawls. |
| **Rendered crawler** | Node sidecar (keep) | Playwright is battle-tested; chromiumoxide is no meaningful win; switching doesn't make Chromium faster. Only used when `--render` set or JS detected. |
| **Raw-exchange store (new)** | Rust | Content-addressed object store with zstd + trained dictionary. Dedup identical template responses. |
| **Metadata + derived store** | Rust / SQLite (keep, evolve) | Metadata + content-hash pointers + derived fields. |
| **Query + aggregation layer (new)** | Rust | All faceted MCP tools (`find_pages_where`, `group_by`, `diff_pages`, etc.) run here as parametric SQL. This is what the MCP server and the UI both consume. |
| **MCP server** | Node (keep, thin adapter) | Translates MCP protocol → Rust query layer over Tauri/IPC or local HTTP. |
| **UI** | Vue (restructure, don't rewrite) | Widget renderer + raw-bytes inspector + claim-annotation log. No business logic. All aggregation comes from Rust. |

### The "UI feels slow" fixes (none of them involve a Rust rewrite)

1. Move every aggregation (duplicates, orphans, diffs, rollups) to Rust SQL behind Tauri commands. Frontend asks, receives pre-cooked answer, renders.
2. Batch streamed `crawl-result` events at the Tauri boundary before they hit Vue reactivity (we partially debated this earlier; do it now as part of the redesign).
3. Virtualize Tabulator properly or replace with a purpose-built virtual grid (heavier columns only materialize on scroll-in).
4. Any >5 ms frontend work moves to a web worker.
5. Cap reactive watchers to `props.results.length` / coarse triggers; never reactive over the full array.
6. Generative-UI renderer means most views stop being hand-built panels — simpler code, fewer hot paths.

### Execution staging (proposed)

Rough phases, each independently shippable:

1. **P1 — Rust raw-exchange store**: zstd-dict compressed, content-addressed, behind a Tauri command. Sidecar writes raw envelopes into it per page. No UI yet — foundation only.
2. **P2 — Rust HTTP fast-path crawler**: new Rust module, speaks the same NDJSON result format as the Node sidecar so everything downstream is unchanged. User picks mode per crawl (`Fast HTTP` / `Render with browser`). Default Fast.
3. **P3 — Rust query layer**: parametric SQL tools (`find_pages_where`, `count_where`, `group_by`, `diff_pages`, `hreflang_reciprocity`, etc.) as Tauri commands. Frontend starts consuming them instead of doing aggregation in JS.
4. **P4 — Widget renderer in Vue**: small typed registry (`count`, `bar_chart`, `table`, `url_list`, `diff`, `graph`). Dashboard is a grid of saved widgets. Old panels deprecated one by one.
5. **P5 — MCP server exposes the Rust query layer**: every UI widget has a matching MCP tool. Claude Code can do anything the UI can, and vice versa.
6. **P6 — Claim-annotation loop**: persistent claim log, user confirm/refute, verification backstop.

Each phase is independently useful — the human-only path keeps working throughout, and the AI-assisted path unlocks incrementally.

## Product positioning refinements (2026-04-24, later)

### Stealth is baseline, not a mode

User call: every crawl is stealth. "Fera doesn't get blocked, period." Stealth params (UA pool, Sec-CH-UA, rate limits, init-script patches) are internal config — the user never toggles them in the normal settings panel. An Advanced panel keeps an override escape hatch for edge cases.

Profiles now differ on **extraction depth and enrichment sources**, not on evasion strategy:

| Profile | Extracts | External data |
| --- | --- | --- |
| Quick scan | HTML + core SEO | none |
| Media audit | + og:image download + dims | none |
| Schema-validated | + JSON-LD validation against schema.org, hreflang reciprocity graph | schema.org vocab (cached) |
| Deep audit | + Core Web Vitals + full raw exchange capture | schema.org + optional Lighthouse |
| Custom | user-defined | user-defined |

MCP implication: Claude picks a profile by choosing enrichment depth, not by configuring bot-evasion knobs. `create_crawl({ profile: "deep_audit", start_url: "..." })` — one call, one concept.

### Visual direction

Two-layered visual system, not one:

- **Dashboard / crawl / insights** — Mission Control density aesthetic (user-approved reference): dark theme, cyan/teal accent, left-panel AI Insights / claim log, right-panel stacked data cards for generative widgets, segmented bottom row of aggregates, **bottom command bar as the primary AI entry point ("Tell us what you want to know about this crawl")**. Central hero replaced with a live crawl visualization (link graph drawing as URLs come in; redirect flows; orphan clusters). Widget-driven per P4.
- **Settings / profile management / auth** — calmer, restrained. VS Code-style sectioned panel, search-first, dense type, no hero visuals. Looking at settings should not feel like mission control.

Don't steal from the reference: orbital/space ornamentation, overdecorated glows, marketing CTAs. Stay closer to Linear / Raycast restraint. One accent color, tight hierarchy.

## Status

Architecture direction agreed pending user decision. Next: write P0 plan for settings architecture (schema-driven, sectioned, profiles, Tauri store) — see below.

## Phase 0 — Settings architecture (to be planned separately)

Will be staged as `docs/plans/2026-04-25-settings-architecture.md` (or dated when written). Key constraints already agreed:

- One schema file drives everything (UI inputs, sidecar CLI args, Rust passthrough, MCP tools, defaults).
- No stealth/evasion settings in the user-visible panel — stealth is baseline.
- Profiles as first-class objects, differing on extraction + enrichment only.
- Persistent via Tauri store or SQLite.
- Search-first settings panel (VS Code-style).
- MCP exposes `get_settings`, `update_settings`, `create_profile`, `list_profiles` tools so Claude can author crawl configs.

This must ship before immediate-wins (stealth + resource blocking + rate limiting) so those new behaviours land directly into the schema instead of being bolted on.


