# Block Detection, Auto-Pause, and Probe Matrix — Design

**Date:** 2026-04-24
**Status:** Design approved, ready for implementation plan

## Problem

When a site starts blocking the crawler mid-run (e.g., consumerreports.org returning 403 from CloudFront/AmazonS3 on every request), the user has no signal beyond scrolling the log. The crawl keeps hammering a wall, wasting time and further poisoning the site's opinion of the crawler.

## Goal

Detect sustained blocking per host, pause crawling **for that host only**, show the user a banner, and offer an optional probe that tests a ladder of escalating stealth configs to find one that works.

## Scope decisions

- **Per-host gating, not global pause.** The existing global pause is erratic; this feature deliberately sidesteps it by adding a per-host queue gate inside the sidecar. Fixing global pause is a separate task.
- **Full matrix probe (6 rows), serial execution, 1 sample URL per row.** Parallel probes would further anger an already-blocking host.
- **All matrix results shown to the user regardless of outcome.** Nothing hidden.
- **If all probe rows fail**, prompt the user to manually open the page in their browser to distinguish fingerprint block vs IP ban.

---

## Architecture

```
┌──────────────┐     NDJSON stdout       ┌──────────────┐     Tauri emit     ┌──────────────┐
│   Sidecar    │  ─────────────────────> │    Rust      │  ────────────────> │   Frontend   │
│              │  block-detected         │              │  block-detected    │              │
│  - crawl     │  probe-result           │  - forward   │  probe-result      │  BlockAlert  │
│  - detector  │                         │  - run_probe │                    │   banner +   │
│  - gate      │  <─────────────────     │    command   │  <───────────────  │  probe modal │
│              │  resume-host  stdin     │              │  invoke            │              │
│              │  stop-host    stdin     │              │                    │              │
└──────────────┘                         └──────────────┘                    └──────────────┘
```

- **Sidecar** owns detection + host gating + probe execution.
- **Rust** forwards events, exposes `run_probe`, `resume_host`, `stop_host` commands; writes stdin commands to sidecar.
- **Frontend** shows the banner and probe modal.

---

## Detection (sidecar)

New module `sidecar/src/blockDetector.ts`. One instance per crawl.

```ts
type HostState = {
  window: Array<{ blocked: boolean; reason?: string; url: string }>;  // rolling 15
  titleCounts: Map<string, Set<string>>;  // title -> distinct URLs
  gated: boolean;
};
```

### Classification — a response is "blocked" if ANY of:

1. `status ∈ {403, 429}` or `status >= 500`
2. Title or body matches: `/access denied|attention required|just a moment|verify you are human|are you a robot|pardon our interruption|request unsuccessful/i`
3. Same `<title>` already seen on ≥3 distinct URLs for this host AND status is 200 (structural soft-block)

### Threshold

- Per host, rolling window of last 15 responses.
- Trip when `blocked_count >= 10` in the window and `gated === false`.
- On trip: set `gated = true`, emit `block-detected`, sidecar gate stops dequeuing URLs for that host.

### Thresholds live as constants at top of `blockDetector.ts` (no config plumbing for v1).

### Emitted event

```json
{
  "type": "block-detected",
  "host": "www.consumerreports.org",
  "reasons": { "status_403": 8, "status_5xx": 0, "soft_title": 2 },
  "stats": { "blocked": 10, "window": 15 },
  "sampleUrls": [
    "https://www.consumerreports.org/.../power-airfryer-xl/m403223/",
    "..."
  ]
}
```

### Reset

`gated` clears only when Rust sends `{"cmd":"resume-host","host":"..."}` over stdin.

---

## Host gate (sidecar)

- Add to dequeue loop: `if (detector.isGated(host)) park in gatedQueue; continue;`
- New stdin handlers:
  - `{"cmd":"resume-host","host":"..."}` — clears gate, moves parked URLs back to main queue.
  - `{"cmd":"stop-host","host":"..."}` — drops parked URLs, marks them as skipped in output.
- Multiple hosts can be gated simultaneously; other hosts keep crawling.

---

## Rust wiring

In the NDJSON parse loop (`src-tauri/src/commands.rs` or equivalent):

- Recognize `type: "block-detected"` → `app.emit("block-detected", payload)`.
- Recognize `type: "probe-result"` → `app.emit("probe-result", payload)`.

New Tauri commands:

- `resume_host(host: String)` — writes resume JSON to sidecar stdin.
- `stop_host(host: String)` — writes stop JSON to sidecar stdin.
- `run_probe(host: String, sample_url: String)` — spawns a fresh `fera-crawler --probe` subprocess with the matrix, streams `probe-result` events.

No changes to crawl lifecycle or generation counter.

---

## Frontend banner — `BlockAlert.vue`

- Mounts once in the crawl view, above the grid.
- Listens for `block-detected`, keeps `Map<host, BlockInfo>` (one row per blocked host).
- Each row shows:
  - Host + "paused — N of last 15 requests blocked"
  - Reason breakdown ("8× 403, 2× soft-block title match")
  - Buttons: **Resume** / **Stop host** / **Probe**
- Cleanup listener in `onUnmounted`.
- Follows `frontend/designrules.md`.

---

## Probe matrix

### Matrix (6 rows, serial, one sample URL each)

| # | Stealth           | Rate    | Warmup | Fresh profile | Residential UA |
|---|-------------------|---------|--------|---------------|----------------|
| 1 | off               | current | off    | no            | no             |
| 2 | tier-1            | 2×      | on     | no            | no             |
| 3 | tier-2            | 2×      | on     | no            | no             |
| 4 | tier-2            | 4×      | on     | no            | no             |
| 5 | tier-2            | 4×      | on     | yes           | no             |
| 6 | tier-2            | 4×      | on     | yes           | yes            |

### Sidecar `--probe` mode

Runs the 6 configs serially. For each row, emits:

```json
{
  "type": "probe-result",
  "row": 3,
  "config": { "stealth": "tier-2", "rate": "2x", "warmup": true, "freshProfile": false, "residentialUa": false },
  "status": 200,
  "title": "Air Fryer Reviews - Consumer Reports",
  "blocked": false,
  "reason": null,
  "durationMs": 4820
}
```

Uses the **same `blockDetector` classification** — a 200 with a block-phrase title is flagged `blocked: true, reason: "soft_title"`.

### Probe modal (Vue)

- 6-row table, renders live as results stream in (spinner → row result).
- Columns: `#`, Config, Status, Title, Result (✓ real 200 / ✗ reason), Duration.
- **At least one success:**
  - Highlight first successful row.
  - "Apply this config & Resume" button — updates per-host config in settings, sends `resume-host`.
- **All 6 fail:**
  - Red summary: *"All 6 configs were blocked. This may be an IP-level ban."*
  - Text: *"Open [sampleUrl] in your regular browser. If it loads fine there but not here, it's a fingerprint issue (try again later or use a different network). If it's blocked there too, your IP is banned — use a VPN or wait 24h."*
  - "Open in browser" button (Tauri opener plugin).

All 6 rows stay on screen regardless of outcome.

---

## Out of scope for v1

- Configurable detection thresholds (constants for now; tune via code).
- Auto-apply winning probe config without user confirmation.
- Parallel probes.
- Persistent per-host config memory across sessions (probe apply only affects current crawl).
- Fixing the erratic global pause — separate task.

---

## Open risks

- **Probe mode shares sidecar code paths with crawl.** Need clean separation so probe doesn't write to crawl output, doesn't mutate crawl state.
- **Title regex false positives** on legitimate pages that happen to mention "access denied" etc. Mitigation: phrase list is conservative; soft-block only trips alongside repeated-title signal or when combined with hard blocks in the same window.
- **Host-gate correctness under redirects.** Classify by *final* response host, not initial request host, to avoid gating wrong host when site redirects to a CDN.
