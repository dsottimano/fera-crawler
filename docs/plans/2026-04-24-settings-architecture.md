# 2026-04-24 — P0: Settings Architecture

**Blocks:** all feature work (`2026-04-24-immediate-wins.md`, stealth/perf, future Rust HTTP fast-path). Do this first.

**Goal:** one schema drives every place settings currently live. Adding a knob becomes a one-line change. Stealth is baseline and invisible in the default panel. Profiles are first-class persisted objects that Claude Code can author via MCP.

**Context pointers (read before executing):**
- `docs/plans/future-fera.md` — architectural direction (stealth-baseline decision, Mission Control aesthetic, profile axis = extraction + enrichment depth).
- `docs/plans/2026-04-24-immediate-wins.md` — depends on this plan; the new stealth/perf settings land directly into the schema defined here.
- `CLAUDE.md` (root) + `frontend/designrules.md` — non-negotiable styling rules for new components.

---

## Why

Current state: every setting exists in five places at once — UI form field, Vue composable state, `useCrawl` invoke payload, sidecar CLI flag parser (`sidecar/src/index.ts`), Rust `start_crawl` params (`src-tauri/src/commands.rs`). Adding one knob is a five-file change with drift risk on defaults. That's the root cause behind both "buggy UI" and "the settings modals feel silly" — it's not UI design, it's architecture.

After P0: schema is the source of truth. UI inputs, defaults, validation, CLI args, Rust passthrough, and MCP tool shapes all derive from it.

---

## Design

### 1. Schema shape

New file: `frontend/src/settings/schema.ts`.

```ts
export type SettingType =
  | "boolean" | "number" | "string" | "enum" | "rules" | "secret" | "url";

export interface SettingDef<T = unknown> {
  type: SettingType;
  default: T;
  label: string;          // UI label
  help?: string;          // one-line user-facing explainer
  advanced?: boolean;     // hidden from normal panel; shows under Advanced toggle
  hidden?: boolean;       // never user-visible; internal baseline (stealth params)
  min?: number; max?: number;
  options?: string[];     // for enum
  unit?: string;          // e.g. "ms", "MB"
  validate?: (v: T) => string | null; // null = ok, string = error message
}

export interface SettingsSection {
  label: string;
  icon?: string;          // lucide icon name
  items: Record<string, SettingDef>;
}

export type SettingsSchema = Record<string, SettingsSection>;

export const SCHEMA_VERSION = 1;
export const SCHEMA: SettingsSchema = {
  crawling: {
    label: "Crawling",
    items: {
      mode:          { type: "enum", default: "spider", options: ["spider","list"], label: "Crawl mode" },
      concurrency:   { type: "number", default: 5, min: 1, max: 50, label: "Concurrency", help: "Parallel page loads" },
      maxRequests:   { type: "number", default: 0, min: 0, label: "Max URLs", help: "0 = unlimited" },
      delay:         { type: "number", default: 0, min: 0, unit: "ms", label: "Global delay", help: "Per-request floor; per-host rate limit still applies" },
      respectRobots: { type: "boolean", default: true, label: "Respect robots.txt" },
      discoverSitemap: { type: "boolean", default: true, label: "Discover sitemap.xml", help: "Fetch robots-declared + /sitemap.xml to seed URLs" },
    },
  },
  performance: {
    label: "Performance",
    items: {
      blockResources:    { type: "boolean", default: true, label: "Block trackers, ads, fonts, media", help: "Drops 50–80% of page subrequests; ~3–5× faster" },
      closeOnExtract:    { type: "boolean", default: true, label: "Close page after extraction", help: "Don't wait for full load unless Core Web Vitals is on" },
    },
  },
  extraction: {
    label: "Extraction",
    items: {
      captureVitals:    { type: "boolean", default: false, label: "Capture Core Web Vitals", help: "LCP / CLS / FCP — slower, waits for load event" },
      downloadOgImage:  { type: "boolean", default: false, label: "Download og:image" },
      scraperRules:     { type: "rules", default: [], label: "Custom extractors", help: "CSS selectors to extract arbitrary fields" },
    },
  },
  authentication: {
    label: "Authentication",
    items: {
      headless:        { type: "boolean", default: true, label: "Headless mode", help: "Turn off to see the browser" },
      // Browser profile / cookies live on a separate UI surface (ProfileViewer), not in schema.
    },
  },
  storage: {
    label: "Storage",
    items: {
      // Retention / quota come with the raw-exchange store (future-fera P1). Stubs only for now:
      retentionDays:    { type: "number", default: 30, min: 1, advanced: true, label: "Retention days" },
    },
  },
  aiMcp: {
    label: "AI & MCP",
    items: {
      // Populated in future phases (Claude Code integration, generative UI).
    },
  },
  advanced: {
    label: "Advanced",
    items: {
      stealthOverride:       { type: "boolean", default: false, advanced: true, label: "Override stealth defaults", help: "Dangerous — may cause blocks" },
      stealthPerHostDelay:   { type: "number", default: 500, min: 0, unit: "ms", advanced: true, label: "Per-host delay override" },
      stealthPerHostConcurrency: { type: "number", default: 2, min: 1, max: 10, advanced: true, label: "Per-host concurrency override" },
      debugLog:              { type: "boolean", default: false, advanced: true, label: "Verbose sidecar logging" },
    },
  },
  // ── Internal (never rendered in UI) ──
  _stealth: {
    label: "Stealth (internal)",
    items: {
      rotateUa:            { type: "boolean", default: true, hidden: true, label: "" },
      uaPool:              { type: "string", default: "default", hidden: true, label: "" }, // pool identifier
      emitSecChUa:         { type: "boolean", default: true, hidden: true, label: "" },
      applyInitPatches:    { type: "boolean", default: true, hidden: true, label: "" },
      retry429:            { type: "boolean", default: true, hidden: true, label: "" },
    },
  },
};
```

Key properties:
- `hidden: true` = internal baseline, never surfaced in the UI. Stealth params live here.
- `advanced: true` = shows under an "Advanced" reveal. Stealth override escape hatch lives here.
- Section keys prefixed `_` (e.g. `_stealth`) are by convention internal; the panel filters them out.

### 2. TypeScript types derived from schema

New file: `frontend/src/settings/types.ts`.

```ts
export type SettingsValues = {
  crawling: {
    mode: "spider" | "list";
    concurrency: number;
    maxRequests: number;
    delay: number;
    respectRobots: boolean;
    discoverSitemap: boolean;
  };
  performance: { blockResources: boolean; closeOnExtract: boolean };
  extraction: {
    captureVitals: boolean;
    downloadOgImage: boolean;
    scraperRules: ScraperRule[];
  };
  authentication: { headless: boolean };
  storage: { retentionDays: number };
  aiMcp: {};
  advanced: {
    stealthOverride: boolean;
    stealthPerHostDelay: number;
    stealthPerHostConcurrency: number;
    debugLog: boolean;
  };
  _stealth: {
    rotateUa: boolean;
    uaPool: string;
    emitSecChUa: boolean;
    applyInitPatches: boolean;
    retry429: boolean;
  };
};

export type ScraperRule = { name: string; selector: string };

export interface Profile {
  id: number;
  name: string;
  schemaVersion: number;
  values: SettingsValues;       // full snapshot, not a patch
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  // Per-crawl overrides go in crawl session config_json, not here.
  startUrl?: string;             // default/hint; crawl-time field overrides
}
```

Hand-written to match the schema. Keep in sync on every schema edit (tracked by unit test — see Acceptance).

### 3. Seed profiles

On first run, seed three profiles. Default = `Quick scan`.

```ts
// frontend/src/settings/default-profiles.ts
export const DEFAULT_PROFILES: Array<Omit<Profile, "id"|"createdAt"|"updatedAt">> = [
  {
    name: "Quick scan",
    schemaVersion: SCHEMA_VERSION,
    isDefault: true,
    values: { /* defaults from schema */ },
  },
  {
    name: "Media audit",
    schemaVersion: SCHEMA_VERSION,
    isDefault: false,
    values: { /* defaults + extraction.downloadOgImage=true */ },
  },
  {
    name: "Deep audit",
    schemaVersion: SCHEMA_VERSION,
    isDefault: false,
    values: { /* defaults + captureVitals=true + downloadOgImage=true + blockResources=false */ },
  },
];
```

### 4. Persistence

SQLite via existing `tauri-plugin-sql`. New migration in `src-tauri/src/lib.rs`:

```sql
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  values_json TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  start_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_default ON profiles(is_default) WHERE is_default = 1;
```

Only one `is_default = 1` row enforced at the DB layer.

### 5. Composables

New file: `frontend/src/composables/useSettings.ts`.

```ts
// Reactive access to the current profile's values + mutation + persistence.
// Exposes:
//   settings: Ref<SettingsValues>                 (reactive)
//   activeProfileId: Ref<number | null>
//   switchProfile(id): Promise<void>
//   patch(path, value): Promise<void>             (dotted path, e.g. "crawling.concurrency")
//   resetSection(sectionKey): Promise<void>
//   validate(values): { valid: boolean; errors: Record<string,string> }
// Changes debounce-persist to SQLite. Internal: subscribes to Tauri events if backend emits updates.
```

New file: `frontend/src/composables/useProfiles.ts`.

```ts
// CRUD over profiles table.
//   profiles: Ref<Profile[]>
//   create({ name, basedOn? }): Promise<Profile>
//   duplicate(id, newName): Promise<Profile>
//   rename(id, newName): Promise<void>
//   remove(id): Promise<void>
//   setDefault(id): Promise<void>
```

### 6. Contract to sidecar: config-file

Today, frontend invokes `start_crawl` with ~15 individual fields, Rust converts to CLI flags, sidecar parses flags. This stays CLI for backwards compat, but the primary new path is:

1. Frontend resolves the active profile's `SettingsValues`, merges per-crawl overrides (`startUrl`, ad-hoc tweaks), produces one JSON blob.
2. Frontend invokes `start_crawl` with `{ startUrl, configJson: JSON.stringify(values) }`. No more per-field params.
3. Rust writes `configJson` to a temp file, adds `--config-file <path>` to sidecar args. Cleans up after crawl.
4. Sidecar — new flag `--config-file` — reads the JSON, validates shape against expected keys, builds its internal `CrawlConfig`.

Keep the individual CLI flags in sidecar parser as fallback (used by tests + direct CLI users). Config-file takes precedence when both are present.

Rust param collapse:

```rust
pub async fn start_crawl(
    app: AppHandle,
    start_url: String,
    config_json: String,
) -> Result<(), String> { ... }
```

One JSON blob replaces `max_requests`, `concurrency`, `user_agent`, `respect_robots`, `delay`, `custom_headers`, `mode`, `urls`, `headless`, `download_og_image`, `scraper_rules`, `capture_vitals`. Clean.

Sidecar reads JSON, walks to known keys, fills `CrawlConfig`. Unknown keys ignored (forward-compat). Missing keys use schema defaults (sidecar imports a small `defaults.json` built at compile time from schema — see P0.1).

### 7. UI — SettingsPanel

New files under `frontend/src/components/settings/`:

- `SettingsPanel.vue` — shell: header, search input, three-column layout. Left: section nav (filtered by search). Middle: active section's items. Right: contextual help.
- `SettingsSection.vue` — renders one section: label + list of `SettingsItem`.
- `SettingsItem.vue` — dispatches on `def.type` to an input component. Shows label, help, current value, error state.
- `inputs/BooleanInput.vue` — Toggle.
- `inputs/NumberInput.vue` — numeric with unit suffix.
- `inputs/StringInput.vue` — text.
- `inputs/EnumInput.vue` — segmented control (2–4 options) or select (>4).
- `inputs/RulesInput.vue` — migrate scraper-rules editor out of existing component.
- `inputs/SecretInput.vue` — password-field with show/hide (unused in P0 but ready).

Search behavior (VS Code style):
- Typing filters section nav: sections with zero matching items are hidden.
- Also filters items within visible section: only matching items render.
- Match is case-insensitive against `label`, `help`, and key.

Advanced reveal:
- Toggle in panel header: "Show advanced". When off, items with `advanced: true` are hidden entirely.
- Always hidden: items with `hidden: true` and sections prefixed `_`.

Visual direction: VS Code / Linear restraint. No mission-control ornamentation here. Per `future-fera.md` § Visual direction.

### 8. ProfileManager + ProfilePicker

- `ProfileManager.vue` — list of profiles, actions (new / duplicate / rename / delete / set-default), lives in a drawer or modal opened from the settings header.
- `ProfilePicker.vue` — small dropdown used in the crawl dock (next to the URL field). Shows active profile name + lets user switch or open manager.

Per-crawl overrides: when starting a crawl, user can tweak a few fields ad-hoc without modifying the profile (e.g. bump concurrency for this run). Stored only on the crawl session record.

### 9. MCP tools (design-only for P0; implementation deferred)

Document the intended MCP surface so Claude Code can drive settings later:

- `get_schema()` → full `SettingsSchema` (helps Claude reason about what's configurable).
- `list_profiles()` → `Profile[]` metadata (without full `values_json`).
- `get_profile(id)` → full profile.
- `create_profile({ name, basedOn?, patch? })` → new profile. `basedOn` defaults to active profile.
- `update_profile(id, patch)` → deep-merge patch into `values`.
- `delete_profile(id)` / `rename_profile(id, name)` / `set_default_profile(id)`.
- `validate_settings(values)` → dry-run validation.

None shipped in P0; only design documented. Implementation slots in once the Rust query layer lands (future-fera P3/P5).

---

## Execution substeps

Each substep compiles, typechecks, and has a green test before moving on.

### P0.1 — Schema + types + defaults (no UI)

- Create `frontend/src/settings/schema.ts`, `types.ts`, `default-profiles.ts`.
- Build-time script or runtime helper `buildDefaults(schema): SettingsValues` — walks schema, returns defaults.
- Generate `sidecar/src/schema-defaults.json` (committed) so sidecar has defaults without importing frontend.
- Unit test: `schema.test.ts` — for each leaf in schema, `typeof default === declared type`; for `enum`, default is in options; derived `SettingsValues` type matches (type-only assertion via `satisfies`).

**Files:**
- New: `frontend/src/settings/schema.ts`, `types.ts`, `default-profiles.ts`, `tests/settings/schema.test.ts`
- New: `sidecar/src/schema-defaults.json` + build step (one-shot Node script or hand-synced file — prefer build step)

**Green gate:** `npx tsc --noEmit` in frontend and sidecar; schema test passes.

### P0.2 — SQLite migration + useProfiles composable

- Add `profiles` table migration in `src-tauri/src/lib.rs`.
- Seed default profiles on first run (check `COUNT(*) == 0`, insert from `DEFAULT_PROFILES`). Seed runs in Rust via a Tauri setup hook that invokes a small bootstrap command, or in frontend on first mount.
- Simpler: seed from frontend on first mount if `profiles` table is empty. No Rust logic for seeding.
- `useProfiles.ts` composable using `@tauri-apps/plugin-sql`.

**Files:**
- Modified: `src-tauri/src/lib.rs` (migration)
- New: `frontend/src/composables/useProfiles.ts`
- New: `frontend/src/composables/useSettings.ts` (stub — just load/save values; no patch helper yet)

**Green gate:** App boots, SQLite has `profiles` table with 3 seeded rows, `Quick scan` marked default.

### P0.3 — SettingsPanel UI (functional, unstyled)

- Build the nine components listed in § 7.
- Wire search, advanced reveal, per-type input dispatch.
- Mount a "Settings" route/modal reachable from main app chrome.
- Renders all sections except `_`-prefixed and `hidden` items.

**Files:**
- New: `frontend/src/components/settings/*` (9 files)
- Modified: `frontend/src/App.vue` to add a Settings entry point

**Green gate:** Can open settings, change `crawling.concurrency`, value persists across app reload, default profile reflects the change.

### P0.4 — Config-file contract

- Sidecar: add `--config-file <path>` flag in `sidecar/src/index.ts`. When present, read JSON, map to `CrawlConfig`. Precedence over individual CLI flags.
- Rust: new `start_crawl(start_url, config_json)` signature. Write temp file, pass `--config-file`. Track the temp file in the same `temp_files` vector as today's scraper-rules / urls files; clean up on task finish.
- Keep old per-field params available temporarily via a second command `start_crawl_legacy` or a feature flag — see Risks.

**Files:**
- Modified: `sidecar/src/index.ts` (flag parser), possibly `sidecar/src/types.ts` (if new fields)
- Modified: `src-tauri/src/commands.rs`
- New integration test: `sidecar/tests/integration/config-file.test.ts` — exercises `--config-file` path end-to-end against the test server

**Green gate:** all existing integration tests still pass; new config-file test passes.

### P0.5 — Migrate useCrawl + wire ProfilePicker

- `useCrawl.ts` reads active profile's `values`, merges per-crawl overrides (`startUrl`, any ad-hoc tweaks), invokes `start_crawl(start_url, config_json)`.
- Remove the old 15-param invoke shape. Delete now-dead code in scattered UI controls (FilterBar setting toggles, ad-hoc defaults in composables).
- ProfilePicker component rendered in the crawl dock.

**Files:**
- Modified: `frontend/src/composables/useCrawl.ts`
- Modified: `frontend/src/components/FilterBar.vue` (remove duplicated settings)
- New: `frontend/src/components/settings/ProfilePicker.vue`
- Modified: wherever the main crawl URL bar lives — add ProfilePicker next to it

**Green gate:** full round-trip — pick profile, start crawl, verify sidecar used the right config (log `[config]` line on startup from sidecar; grep or assert in test). UI reflects accurate active-profile name.

### P0.6 — ProfileManager UI

- Drawer/modal: list profiles, actions.
- Reached from SettingsPanel header AND from ProfilePicker.

**Files:**
- New: `frontend/src/components/settings/ProfileManager.vue`

**Green gate:** create / duplicate / rename / delete / set-default all work, reflected in DB and in other components.

### P0.7 — Retire old scattered settings UIs

Audit sweep — for each old setting location, either migrate its functionality into SettingsPanel or delete it if redundant. Likely suspects (verify at execution time):

- `FilterBar.vue` settings toggles
- `SettingsFinder.vue` — may have useful logic; fold into new panel or kill
- Any `useCrawl.ts` residue state that mirrors schema values

**Files:** many deletions + small additions.

**Green gate:** grep for old setting keys across frontend; no residual usage. Dev server boots clean.

### P0.8 — Visual polish

Apply `frontend/designrules.md` — calm, sectioned, VS-Code-ish panel. No mission-control density here. Accessibility pass (keyboard nav, focus rings, labels, screen reader names). Search hotkey (Ctrl+F within panel).

**Files:** CSS-only changes to settings components.

**Green gate:** manual design review; keyboard-only walkthrough completes without mouse.

---

## File inventory (aggregate)

**New:**
- `frontend/src/settings/schema.ts`
- `frontend/src/settings/types.ts`
- `frontend/src/settings/default-profiles.ts`
- `frontend/src/settings/validators.ts` (if non-trivial)
- `frontend/src/composables/useSettings.ts`
- `frontend/src/composables/useProfiles.ts`
- `frontend/src/components/settings/SettingsPanel.vue`
- `frontend/src/components/settings/SettingsSection.vue`
- `frontend/src/components/settings/SettingsItem.vue`
- `frontend/src/components/settings/ProfileManager.vue`
- `frontend/src/components/settings/ProfilePicker.vue`
- `frontend/src/components/settings/inputs/{Boolean,Number,String,Enum,Rules,Secret}Input.vue`
- `frontend/tests/settings/schema.test.ts`
- `sidecar/src/schema-defaults.json` (generated or hand-synced)
- `sidecar/tests/integration/config-file.test.ts`

**Modified:**
- `src-tauri/src/lib.rs` — `profiles` migration
- `src-tauri/src/commands.rs` — new `start_crawl(start_url, config_json)` signature
- `sidecar/src/index.ts` — `--config-file` support
- `sidecar/src/types.ts` — key alignment with schema (add missing fields if any)
- `frontend/src/composables/useCrawl.ts` — consume active profile
- `frontend/src/App.vue` — SettingsPanel entry point + ProfilePicker placement

**Deleted (at P0.7):**
- Any scattered per-setting UI controls superseded by SettingsPanel (flag during audit; don't pre-commit to a list).

---

## Acceptance criteria (P0 overall)

- Adding one new setting requires editing exactly one file (`schema.ts`). UI input renders automatically. Default applies automatically. Sidecar reads it via config-file. Rust is untouched.
- SettingsPanel renders from schema with no per-section hand-written code (aside from the generic `SettingsSection.vue`).
- Three seeded profiles exist on first run. Default = Quick scan.
- Profile switch pre-crawl changes what the sidecar receives (verifiable via sidecar stderr log `[config] ...`).
- Crawl session records the full effective config under its existing `config_json` field (unchanged behaviour; this is already how v0.3.0 works per memory).
- Stealth settings are not user-visible in the normal panel. Only the override toggle + two numeric overrides live under Advanced.
- Search filters sections and items correctly.
- All existing sidecar integration tests still pass. New `config-file.test.ts` passes.
- `npx tsc --noEmit` clean in `sidecar/`, `mcp-server/`, and frontend `vue-tsc --noEmit` clean. `cargo check` clean.
- Manual smoke: run a full crawl via the new flow end to end. Results match prior behaviour.

---

## Risks + gotchas

- **Rust signature change is a breaking invoke.** Move together. During development, keep old `start_crawl` command under a different name (`start_crawl_legacy`) for one commit cycle, then delete. Never have both live in production code.
- **Schema drift between `types.ts` and `schema.ts`.** `schema.test.ts` enforces that every leaf exists in both and types align. Keep that test strict.
- **`sidecar/schema-defaults.json` drift.** Easiest fix: a small Node build step run on `npm run build:defaults`, or (simpler initially) a comment in `schema.ts` reminding to update both. If we pick the build step, wire it into sidecar's `prebuild`.
- **Seeded profiles duplicated on re-seed.** Guard: only seed when table empty.
- **Only-one-default enforcement.** SQLite partial unique index (`WHERE is_default = 1`) handles it; write tests that attempt to double-set and expect rejection / swap.
- **Existing crawls in history have old config-json shapes.** No migration needed — viewing an old crawl is read-only and we don't re-interpret its config. New crawls produce new shapes.
- **Scraper rules.** Currently a `rules` type; the editor UI already exists in some form — port it, don't rewrite.
- **Custom headers.** Current `CrawlConfig.customHeaders` is `Record<string, string>`. Not in this plan's schema explicitly. Add as a `headers` section later, or fold under `crawling.customHeaders` with a `dict` type. For P0: leave it where it is and migrate in the follow-up when we add the stealth settings properly.
- **Tauri plugin-sql ergonomics.** Use `tauri-plugin-sql` `load` + direct SQL strings. Tests mock the DB or run against `:memory:`.
- **Claim / MCP tools not implemented in P0.** Document only. Don't write stubs that lie.
- **CLAUDE.md says no emojis.** Don't use them in settings labels.
- **`frontend/designrules.md`.** Re-read before any visual CSS work in P0.8.
- **Don't break `CrawlChild` generation logic.** The one-lock-bump pattern in `commands.rs` stays. Only the crawl-config param shape changes.

---

## Out of scope for P0

- Implementing MCP settings tools (design only, per § 9).
- The Rust HTTP fast-path crawler.
- Raw-exchange object store + zstd dictionary.
- Widget renderer + Mission Control dashboard aesthetic (P4 in `future-fera.md`).
- Per-host overrides (user-defined rules like "for cdn.example.com, use this UA"). Future.
- Secret management / API key storage (no keys needed per stealth-baseline decision and Claude-Code-via-MCP framing; future if we add Lighthouse/Zyte integrations).

---

## Definition of done

P0 is done when:

1. All nine substeps (P0.1 — P0.8) green-gated.
2. Grepping for the old per-field invoke params in `frontend/src/` returns zero non-dead matches.
3. A fresh developer could add a new setting (e.g. `crawling.followSubdomains`) by adding one line to `schema.ts` and get a working UI + CLI plumbing end-to-end.
4. The legacy `start_crawl_legacy` Rust command has been deleted.
5. A manual smoke crawl against the test server uses the new config-file path and produces results indistinguishable from pre-P0 behaviour.
6. `MEMORY.md` + `active_work.md` updated to reflect P0 complete and point at the next plan (`2026-04-24-immediate-wins.md`).
