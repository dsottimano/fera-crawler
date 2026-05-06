# Adaptive Pacing Controller — Design

**Date:** 2026-05-06
**Status:** Approved, pre-implementation
**Author:** Dave + Claude

## Problem

The probe matrix today is one-shot: it picks a row at crawl start, then the crawl runs at that row's `perHostDelayMs` for the entire session. This has two failure modes observed in real crawls:

1. **Too cautious.** On permissive hosts the matrix bottoms out at 2000ms per-host delay (row 1), even when the host would tolerate sub-second pacing. Throughput is left on the table.
2. **No mid-crawl recovery.** If a host's tolerance changes (Akamai escalates, a CDN rule rolls out), the crawl keeps running into walls because nothing re-evaluates pacing.

Real-world example driving this work: a 32,601-URL crawl of consumerreports.org running at row-6-equivalent settings (headed, shared profile, `per-host-delay 2500ms`, `per-host-concurrency 4`) is observing 0.17 pages/sec, ~7.5% block rate, and a 53-hour ETA. The pacing was set once and never re-evaluated.

## Goal

A fully automatic in-crawl controller that:
- Tunes pacing (per-host-delay) toward the fastest rate that still beats blocks.
- Reacts to changing host behavior during the crawl.
- Falls back to re-running the probe matrix when pacing alone can't recover.
- Never modifies user-set crawl config (og-image download, scraper rules, headed mode, etc.). Only the speed/stealth axis is automated.

## Non-goals

- Replacing the probe matrix. The matrix remains the source of truth for stealth/profile/headed combos.
- Per-URL pacing. Controller operates per-host.
- Cross-session learning. Each crawl starts fresh; no persisted controller state across sessions.
- End-to-end CI testing against real anti-bot vendors (non-deterministic, can't be in CI).
- User-facing controls to tune the controller's parameters in v1. Constants live in code; can be promoted to settings later if needed.

## Architecture

```
sidecar (TypeScript)                        Rust backend                frontend
─────────────────────                       ─────────────              ──────────
ResponseClassifier  ──┐
PerHostState        ──┼─→ AdaptiveController ──→ rate limiter (live)
                      │              │
                      │              └── stdout NDJSON ──→ controller-state event ──→ HEALTH "Adaptive Pacing" card
                      │
                      └── re-probe-requested event ──→ Re-probe coordinator
                                                          (drain → probe matrix → respawn sidecar)
```

The steady-state feedback loop runs entirely inside the sidecar — no IPC round-trip per response. Only the panic path (re-probe) crosses the process boundary, which fits cleanly into Rust's existing role as the sidecar's parent.

## Components

### 1. `ResponseClassifier` (sidecar, new)

Stateless function. Per response, returns one of:

| Class | Trigger |
|---|---|
| `ok` | 2xx, `BlockDetector` clean, body looks normal vs. host baseline |
| `blocked-status:403` | HTTP 403 |
| `blocked-status:429` | HTTP 429 |
| `blocked-status:503` | HTTP 503 |
| `blocked-content` | 200, `BlockDetector` positive (challenge title, captcha) |
| `cloaked` | 200, `BlockDetector` clean, but body suspiciously thin vs. host baseline |
| `other` | Non-block 4xx/5xx (404, 410, etc.). Controller ignores. |

### 2. `PerHostState` (sidecar, new)

In-memory map keyed by host. LRU-evicted at 1000 hosts (evicted host re-baselines on return).

Per host:
- **Cloak baseline:** running median of `bodyBytes` and `internalLinks` over the first 20 `ok` responses. Until 20 samples exist on this host, cloak detection is disabled.
- **Cloak rule:** flag a 200 as `cloaked` if `bodyBytes < 0.05 × median_bodyBytes` AND `internalLinks < 0.05 × median_internalLinks`. Both conditions required — guards against legitimately thin pages.
- **Rolling window:** last 100 classified responses (deque). Used only for the block-rate percentage shown on HEALTH and the `>20%` ceiling-saturated re-probe trigger. Not used for AIMD step-down.
- **Clean-streak counter:** integer count of consecutive non-block responses. Increments on `ok`, resets to 0 on any block class.
- **Clean-streak start** (monotonic clock, set when counter resets to 0 after a block, captures the first `ok` after a block).
- **Consecutive 403 counter:** count + first-seen timestamp; resets to 0 on any non-403 response.
- **Current delay** (continuous ms; AIMD operates in continuous space, UI buckets are derived).
- **Last-block-time** (monotonic clock).

### 3. `AdaptiveController` (sidecar, new)

Single tick triggered on each response:

1. Pull classification from `ResponseClassifier`.
2. Update `PerHostState[host]`.
3. AIMD step:
   - **On any block class:** `delay = min(ceil, delay × 1.6)`. Reset clean-streak counter to 0.
   - **On clean response:** if `clean_streak ≥ 200` AND `now − last_block_time ≥ 60s`, then `delay = max(floor, delay − 100ms)` and reset clean-streak counter to 0 (so the next step-down requires another 200 clean responses).
4. If delay changed, call `rateLimiter.setDelay(host, newDelay)`.
5. Emit `controller-state` NDJSON event (debounced to ≤1/s/host).
6. Check re-probe triggers:
   - **403-burst:** ≥10 consecutive 403s within 60s → emit `re-probe-requested`.
   - **Ceiling-saturated:** delay at ceiling for ≥5 minutes AND block rate over rolling window > 20% → emit `re-probe-requested`.
   - Cooldown: 5 minutes (monotonic) between re-probes per host.

**Bounds:** floor 250ms, ceiling 15000ms. Both as TypeScript constants in v1; promote to settings later if needed.

**AIMD constants:** multiplier 1.6, additive step 100ms, clean-window threshold 200 requests, cooldown 60s. All constants in v1; tuning happens through real-world observation, not user config.

### 4. Live rate limiter (sidecar, modified)

The existing per-host rate limiter takes a fixed delay at sidecar startup. Modifications:
- Add `setDelay(host: string, ms: number): void`.
- Add `setConcurrency(host: string, n: number): void` (reserved for future use; not called by controller in v1).
- Delay change applies to the *next* dispatched slot — never mid-wait. In-flight requests are unaffected.

### 5. Re-probe coordinator (Rust, new)

Listens for `re-probe-requested` events on sidecar stdout (existing NDJSON routing).

On receipt:
1. Pause dispatch (stop sending new URLs to sidecar; existing pause path).
2. Drain in-flight (wait up to 30s for current requests to finish; force-cancel after).
3. Run `probeMatrix` against the `sampleUrl` from the event payload.
4. Kill sidecar, respawn with the winning row's CLI args (existing respawn path).
5. Resume dispatch.
6. Append entry to "re-probe events" log (in-memory + emitted to frontend).

If the probe finds zero winning rows: respawn with the previous (failing) row's args at ceiling delay. Frontend's HEALTH card surfaces "PROBING — no row beat blocks." No auto-stop, no auto-modal — user decides next step.

### 6. HEALTH "Adaptive Pacing" card (frontend, new)

Per-host table:

| Host | State | Current delay | Block rate (last 100) | Last action |
|---|---|---|---|---|
| consumerreports.org | STEADY | 1842ms | 6% | stepped down 100ms (12s ago) |
| forbes.com | PROBING | 14000ms | 38% | re-probe pending |
| nyt.com | AGGRESSIVE | 410ms | 0% | stepped down 100ms (40s ago) |

State buckets (derived from delay band):

| Bucket | Range |
|---|---|
| `AGGRESSIVE` | < 1000ms |
| `STEADY` | 1000–3000ms |
| `CAUTIOUS` | 3000–8000ms |
| `PROBING` | > 8000ms |

Below the table: "Re-probe events" log — timestamp, host, trigger reason (`403-burst` / `ceiling-saturated`), winning row from new probe.

## Data flow

### Per response (steady state)

1. Sidecar finishes a request → builds `{url, status, title, bodyBytes, internalLinks}` snapshot.
2. `ResponseClassifier` tags it.
3. `PerHostState[host]` updates baseline + window + counters.
4. `AdaptiveController` decides AIMD step, calls `rateLimiter.setDelay(host, newMs)` if changed.
5. Sidecar emits `controller-state` NDJSON event (debounced ≤1/s/host).
6. Rust forwards to frontend as `pacing-update` event; HEALTH card row updates.

### On re-probe trigger

1. Sidecar emits `re-probe-requested {host, reason, sampleUrl}`.
2. Rust pauses dispatch, drains in-flight (30s timeout).
3. Rust runs probe matrix.
4. Rust respawns sidecar with winning row's args. Per-host state rebuilds from scratch (clean baseline).
5. HEALTH "Re-probe events" log gets a row.

## Decisions deferred to v2

- **Concurrency tuning.** AIMD on concurrency in addition to delay. Cut from v1 because concurrency changes are bigger discontinuities and harder to undo cleanly. `setConcurrency` is reserved in the limiter API for future use.
- **Live row-apply.** Mid-crawl row changes without sidecar respawn. Cut because mid-crawl headed↔headless context swap is ugly. Respawn cost (~5–10s) is amortized by the 5-minute re-probe cooldown.
- **Cross-session persistence.** Saving learned per-host pacing across crawls. Out of scope for v1.
- **User-tunable controller constants.** Bounds / multiplier / window in CONFIG screen. Promoted only if real-world observation shows v1 defaults are wrong for some class of host.

## Error handling

| Failure | Behavior |
|---|---|
| Cloak detection false positive (legitimately thin page) | Damped — needs 20-sample baseline, both body & link thresholds. Worst case: brief unnecessary slowdown, AIMD recovers. |
| Re-probe finds zero winning rows | Sidecar resumes with previous (failing) row at ceiling delay. HEALTH shows "PROBING — no row beat blocks." User decides next step. |
| Sidecar respawn fails | Existing crash path — Rust marks crawl errored, frontend shows existing error UI. No new failure mode. |
| `setDelay` called during in-flight request | Limiter applies new delay to *next* slot, never mid-wait. |
| Cooldown violated by clock skew | Use monotonic clock for cooldown check, not wall clock. |
| Per-host map unbounded on huge multi-host crawls | LRU evict to 1000 hosts. Evicted host re-baselines on return. |
| Controller state corrupts under unexpected response shape | Wrap classifier + tick in try/catch; on error, log and treat response as `other` (controller ignores). |

## Testing

### Unit (sidecar, Vitest)

- `ResponseClassifier`: matrix of `(status, title, bodyBytes, links, baseline)` → expected class.
- `PerHostState`:
  - Cloak baseline median converges over 20 samples.
  - Threshold flags correctly when both conditions met.
  - Sample-count gate: cloak detection inactive before 20 samples.
  - Rolling window evicts at 100 entries.
  - 403 counter resets on non-403.
- `AdaptiveController` AIMD math:
  - Block multiplies delay by 1.6, clamps to ceiling.
  - Clean window of 200 + 60s steps down 100ms, clamps to floor.
  - Cooldown blocks duplicate re-probes.
- Re-probe trigger conditions:
  - 403-burst: 10 consecutive 403s in 60s → fires.
  - Ceiling-saturated: 5min at ceiling + >20% block rate → fires.

### Integration (sidecar test fixture server, `npm test`)

The existing test fixture server (`npm run test:server` on `:5000`) gains scriptable response patterns:
- 200/normal, 200/cloaked, 200/captcha-title, 403, 429.

Tests:
- Drive a fake crawl with a "permissive then walls" pattern; assert pacing converges to expected band.
- Drive a 403-burst pattern; assert `re-probe-requested` fires.
- Drive a ceiling-saturation pattern; assert re-probe fires after the timer.

### Manual smoke

- Run against `localhost:5000` with scripted "permissive then walls" pattern. Watch HEALTH card transitions. No regression test, just confidence check before merging.

### Out of scope

End-to-end against real Akamai/Cloudflare/Datadome. Non-deterministic, can't be in CI. Document a manual-only verification recipe in the eventual wiki page.

## Open questions

None blocking implementation. Items deferred to v2 are listed above.

## Follow-ups

After this ships and is verified in production, write the in-app wiki spec (`2026-05-06-help-wiki-design.md` placeholder). The wiki's `adaptive-pacing.md` page will be authored from observed behavior, not predicted behavior — which is why the wiki ships *after* the controller, not before.
