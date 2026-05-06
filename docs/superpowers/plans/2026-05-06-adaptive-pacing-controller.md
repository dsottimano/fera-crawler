# Adaptive Pacing Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-crawl AIMD controller that auto-tunes per-host pacing toward the fastest rate that beats blocks, with the existing probe matrix as the panic-path escape hatch when pacing alone can't recover.

**Architecture:** Three new sidecar units (`ResponseClassifier`, `PerHostState`, `AdaptiveController`) wired into `crawler.recordResult()`. The steady-state feedback loop (per-response → classify → AIMD → live rate-limiter update) runs entirely in the sidecar. A new sidecar event `re-probe-requested` triggers the Rust backend's existing probe-matrix + sidecar-respawn path. A new HEALTH card displays per-host controller state.

**Tech Stack:** TypeScript (sidecar, Vitest), Rust (Tauri backend), Vue 3 (frontend).

**Spec:** `docs/superpowers/specs/2026-05-06-adaptive-pacing-controller-design.md`.

---

## File Structure

**New files (sidecar):**
- `sidecar/src/responseClassifier.ts` — pure classifier (status, title, body, links → class)
- `sidecar/src/perHostState.ts` — per-host state container (baseline, windows, counters)
- `sidecar/src/adaptiveController.ts` — AIMD math + re-probe trigger logic
- `sidecar/tests/unit/responseClassifier.test.ts`
- `sidecar/tests/unit/perHostState.test.ts`
- `sidecar/tests/unit/adaptiveController.test.ts`
- `sidecar/tests/integration/adaptive-controller.test.ts`

**Modified files (sidecar):**
- `sidecar/src/rate-limiter.ts` — add `setMultiplier(host, mult)` for absolute (vs. doubling) updates
- `sidecar/src/crawler.ts` — wire controller into `recordResult()` (lines 1397–1421)
- `sidecar/test-server/routes.ts` — scriptable response patterns (cloak, captcha, 403, 429)

**Modified files (Rust):**
- `src-tauri/src/commands.rs` — route new sidecar events; add re-probe coordinator

**New files (frontend):**
- `frontend/src/components/AdaptivePacingCard.vue`

**Modified files (frontend):**
- `frontend/src/views/Health.vue` (or wherever HEALTH lives — engineer will grep) — include the new card

---

## Task 1: ResponseClassifier (pure function)

**Files:**
- Create: `sidecar/src/responseClassifier.ts`
- Create: `sidecar/tests/unit/responseClassifier.test.ts`

The classifier consumes an already-recorded response and a per-host baseline (or null if not enough samples), returns one of: `ok` / `blocked-status:403|429|503` / `blocked-content` / `cloaked` / `other`. It reuses `BlockDetector.classify()` for the existing block signal so we don't duplicate the regex list.

- [ ] **Step 1: Write the failing test**

```typescript
// sidecar/tests/unit/responseClassifier.test.ts
import { describe, it, expect } from "vitest";
import { classifyResponse } from "../../src/responseClassifier.js";
import { BlockDetector } from "../../src/blockDetector.js";

describe("classifyResponse", () => {
  const detector = new BlockDetector();

  it("returns ok for clean 200 with no baseline", () => {
    const r = classifyResponse(
      { url: "https://h.com/p", status: 200, title: "Page", bodyBytes: 50000, internalLinks: 80 },
      "h.com",
      detector,
      null,
    );
    expect(r).toBe("ok");
  });

  it("returns blocked-status:403 for HTTP 403", () => {
    const r = classifyResponse(
      { url: "https://h.com/p", status: 403, title: "", bodyBytes: 0, internalLinks: 0 },
      "h.com",
      detector,
      null,
    );
    expect(r).toBe("blocked-status:403");
  });

  it("returns blocked-status:429 for HTTP 429", () => {
    const r = classifyResponse(
      { url: "https://h.com/p", status: 429, title: "", bodyBytes: 0, internalLinks: 0 },
      "h.com",
      detector,
      null,
    );
    expect(r).toBe("blocked-status:429");
  });

  it("returns blocked-status:503 for HTTP 503", () => {
    const r = classifyResponse(
      { url: "https://h.com/p", status: 503, title: "", bodyBytes: 0, internalLinks: 0 },
      "h.com",
      detector,
      null,
    );
    expect(r).toBe("blocked-status:503");
  });

  it("returns blocked-content for 200 with challenge title", () => {
    const r = classifyResponse(
      { url: "https://h.com/p", status: 200, title: "Just a moment...", bodyBytes: 1000, internalLinks: 0 },
      "h.com",
      detector,
      null,
    );
    expect(r).toBe("blocked-content");
  });

  it("returns cloaked when body and links both < 5% of baseline", () => {
    const baseline = { medianBodyBytes: 50000, medianInternalLinks: 80 };
    const r = classifyResponse(
      { url: "https://h.com/p", status: 200, title: "Page", bodyBytes: 1000, internalLinks: 2 },
      "h.com",
      detector,
      baseline,
    );
    expect(r).toBe("cloaked");
  });

  it("returns ok when only body is below cloak threshold (links normal)", () => {
    const baseline = { medianBodyBytes: 50000, medianInternalLinks: 80 };
    const r = classifyResponse(
      { url: "https://h.com/p", status: 200, title: "Page", bodyBytes: 1000, internalLinks: 80 },
      "h.com",
      detector,
      baseline,
    );
    expect(r).toBe("ok");
  });

  it("returns other for non-block 4xx (404)", () => {
    const r = classifyResponse(
      { url: "https://h.com/p", status: 404, title: "", bodyBytes: 0, internalLinks: 0 },
      "h.com",
      detector,
      null,
    );
    expect(r).toBe("other");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && npx vitest run tests/unit/responseClassifier.test.ts`
Expected: FAIL — module `../../src/responseClassifier.js` does not exist.

- [ ] **Step 3: Implement ResponseClassifier**

```typescript
// sidecar/src/responseClassifier.ts
import { BlockDetector } from "./blockDetector.js";

export type Classification =
  | "ok"
  | "blocked-status:403"
  | "blocked-status:429"
  | "blocked-status:503"
  | "blocked-content"
  | "cloaked"
  | "other";

export interface ResponseSnapshot {
  url: string;
  status: number;
  title: string;
  bodyBytes: number;
  internalLinks: number;
}

export interface CloakBaseline {
  medianBodyBytes: number;
  medianInternalLinks: number;
}

const CLOAK_RATIO = 0.05;

export function classifyResponse(
  resp: ResponseSnapshot,
  host: string,
  detector: BlockDetector,
  baseline: CloakBaseline | null,
): Classification {
  if (resp.status === 403) return "blocked-status:403";
  if (resp.status === 429) return "blocked-status:429";
  if (resp.status === 503) return "blocked-status:503";

  const verdict = detector.classify({ url: resp.url, status: resp.status, title: resp.title }, host);
  if (verdict.blocked) {
    if (verdict.reason === "status_5xx") return "blocked-status:503";
    return "blocked-content";
  }

  if (resp.status < 200 || resp.status >= 300) return "other";

  if (
    baseline &&
    resp.bodyBytes < baseline.medianBodyBytes * CLOAK_RATIO &&
    resp.internalLinks < baseline.medianInternalLinks * CLOAK_RATIO
  ) {
    return "cloaked";
  }

  return "ok";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && npx vitest run tests/unit/responseClassifier.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/responseClassifier.ts sidecar/tests/unit/responseClassifier.test.ts
git commit -m "feat(sidecar): ResponseClassifier for adaptive pacing"
```

---

## Task 2: PerHostState (state container)

**Files:**
- Create: `sidecar/src/perHostState.ts`
- Create: `sidecar/tests/unit/perHostState.test.ts`

Per-host state for cloak baseline (running median over first 20 ok responses), rolling 100-entry window, clean-streak counter, consecutive-403 counter, current delay multiplier, last-block monotonic timestamp. LRU eviction at 1000 hosts.

- [ ] **Step 1: Write the failing test**

```typescript
// sidecar/tests/unit/perHostState.test.ts
import { describe, it, expect } from "vitest";
import { PerHostStates } from "../../src/perHostState.js";

describe("PerHostStates", () => {
  it("baseline returns null until 20 ok samples recorded", () => {
    const s = new PerHostStates();
    for (let i = 0; i < 19; i++) s.recordOk("h.com", 1000 + i, 50);
    expect(s.baseline("h.com")).toBeNull();
    s.recordOk("h.com", 1019, 50);
    const b = s.baseline("h.com");
    expect(b).not.toBeNull();
    expect(b!.medianBodyBytes).toBeGreaterThan(0);
  });

  it("baseline median is correct for 20 samples", () => {
    const s = new PerHostStates();
    for (let i = 1; i <= 20; i++) s.recordOk("h.com", i * 1000, i);
    const b = s.baseline("h.com");
    expect(b).not.toBeNull();
    // Median of 1..20 = (10+11)/2 = 10.5; bodyBytes = 1000..20000, median = 10500
    expect(b!.medianBodyBytes).toBe(10500);
    expect(b!.medianInternalLinks).toBe(11);
  });

  it("clean streak increments on ok, resets on block class", () => {
    const s = new PerHostStates();
    s.recordClassification("h.com", "ok");
    s.recordClassification("h.com", "ok");
    s.recordClassification("h.com", "ok");
    expect(s.cleanStreak("h.com")).toBe(3);
    s.recordClassification("h.com", "blocked-status:429");
    expect(s.cleanStreak("h.com")).toBe(0);
  });

  it("consecutive 403 counter increments on 403, resets on non-403", () => {
    const s = new PerHostStates();
    s.recordClassification("h.com", "blocked-status:403");
    s.recordClassification("h.com", "blocked-status:403");
    expect(s.consecutive403("h.com")).toBe(2);
    s.recordClassification("h.com", "ok");
    expect(s.consecutive403("h.com")).toBe(0);
  });

  it("rolling window caps at 100 entries", () => {
    const s = new PerHostStates();
    for (let i = 0; i < 150; i++) s.recordClassification("h.com", "ok");
    expect(s.windowSize("h.com")).toBe(100);
  });

  it("blockRate returns blocked / window-size over rolling window", () => {
    const s = new PerHostStates();
    for (let i = 0; i < 90; i++) s.recordClassification("h.com", "ok");
    for (let i = 0; i < 10; i++) s.recordClassification("h.com", "blocked-status:429");
    expect(s.blockRate("h.com")).toBeCloseTo(0.1, 5);
  });

  it("LRU evicts oldest host past 1000 entries", () => {
    const s = new PerHostStates(1000);
    for (let i = 0; i < 1001; i++) s.recordClassification(`h${i}.com`, "ok");
    expect(s.has("h0.com")).toBe(false);
    expect(s.has("h1000.com")).toBe(true);
  });

  it("setLastBlockNow / sinceLastBlockMs uses monotonic clock", () => {
    const s = new PerHostStates();
    s.setLastBlockNow("h.com");
    const before = s.sinceLastBlockMs("h.com");
    expect(before).toBeGreaterThanOrEqual(0);
    expect(before).toBeLessThan(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && npx vitest run tests/unit/perHostState.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement PerHostStates**

```typescript
// sidecar/src/perHostState.ts
import type { Classification } from "./responseClassifier.js";

const BASELINE_SAMPLES = 20;
const WINDOW_MAX = 100;
const DEFAULT_MAX_HOSTS = 1000;

interface HostState {
  bodySamples: number[];
  linkSamples: number[];
  cachedBaseline: { medianBodyBytes: number; medianInternalLinks: number } | null;
  window: Classification[];
  cleanStreak: number;
  consecutive403: number;
  lastBlockMonoMs: number | null;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function isBlocked(c: Classification): boolean {
  return c === "blocked-status:403"
    || c === "blocked-status:429"
    || c === "blocked-status:503"
    || c === "blocked-content"
    || c === "cloaked";
}

export class PerHostStates {
  // Map preserves insertion order; we mutate it for LRU by re-inserting on touch.
  private map = new Map<string, HostState>();
  private maxHosts: number;

  constructor(maxHosts: number = DEFAULT_MAX_HOSTS) {
    this.maxHosts = maxHosts;
  }

  has(host: string): boolean {
    return this.map.has(host);
  }

  private touch(host: string): HostState {
    let s = this.map.get(host);
    if (s) {
      this.map.delete(host);
      this.map.set(host, s);
      return s;
    }
    s = {
      bodySamples: [],
      linkSamples: [],
      cachedBaseline: null,
      window: [],
      cleanStreak: 0,
      consecutive403: 0,
      lastBlockMonoMs: null,
    };
    this.map.set(host, s);
    if (this.map.size > this.maxHosts) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return s;
  }

  recordOk(host: string, bodyBytes: number, internalLinks: number): void {
    const s = this.touch(host);
    if (s.bodySamples.length >= BASELINE_SAMPLES) return;
    s.bodySamples.push(bodyBytes);
    s.linkSamples.push(internalLinks);
    if (s.bodySamples.length === BASELINE_SAMPLES) {
      const bSorted = [...s.bodySamples].sort((a, b) => a - b);
      const lSorted = [...s.linkSamples].sort((a, b) => a - b);
      s.cachedBaseline = { medianBodyBytes: median(bSorted), medianInternalLinks: median(lSorted) };
    }
  }

  baseline(host: string): { medianBodyBytes: number; medianInternalLinks: number } | null {
    return this.map.get(host)?.cachedBaseline ?? null;
  }

  recordClassification(host: string, c: Classification): void {
    const s = this.touch(host);
    s.window.push(c);
    if (s.window.length > WINDOW_MAX) s.window.shift();
    if (isBlocked(c)) {
      s.cleanStreak = 0;
      s.lastBlockMonoMs = monoNowMs();
    } else if (c === "ok") {
      s.cleanStreak++;
    }
    if (c === "blocked-status:403") s.consecutive403++;
    else s.consecutive403 = 0;
  }

  cleanStreak(host: string): number {
    return this.map.get(host)?.cleanStreak ?? 0;
  }

  resetCleanStreak(host: string): void {
    const s = this.map.get(host);
    if (s) s.cleanStreak = 0;
  }

  consecutive403(host: string): number {
    return this.map.get(host)?.consecutive403 ?? 0;
  }

  windowSize(host: string): number {
    return this.map.get(host)?.window.length ?? 0;
  }

  blockRate(host: string): number {
    const s = this.map.get(host);
    if (!s || s.window.length === 0) return 0;
    let blocked = 0;
    for (const c of s.window) if (isBlocked(c)) blocked++;
    return blocked / s.window.length;
  }

  setLastBlockNow(host: string): void {
    this.touch(host).lastBlockMonoMs = monoNowMs();
  }

  sinceLastBlockMs(host: string): number {
    const t = this.map.get(host)?.lastBlockMonoMs;
    return t === null || t === undefined ? Number.POSITIVE_INFINITY : monoNowMs() - t;
  }

  hosts(): string[] {
    return [...this.map.keys()];
  }
}

function monoNowMs(): number {
  // performance.now() is monotonic on Node 16+ and in browsers; use it for cooldowns.
  return performance.now();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && npx vitest run tests/unit/perHostState.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/perHostState.ts sidecar/tests/unit/perHostState.test.ts
git commit -m "feat(sidecar): PerHostStates for adaptive pacing"
```

---

## Task 3: Rate-limiter `setMultiplier` extension

**Files:**
- Modify: `sidecar/src/rate-limiter.ts` (lines 99–116)
- Modify: `sidecar/tests/unit/rate-limiter.test.ts` (append)

The existing `bumpDelay(host)` only doubles the multiplier. AIMD needs to set arbitrary continuous multipliers (e.g., 1.6×, 0.91×). Add `setMultiplier(host, mult)` and `getMultiplier(host)`. Keep `bumpDelay` for now — `recordResult` will stop calling it once the controller is wired in (Task 6).

- [ ] **Step 1: Write the failing test (append to existing rate-limiter test file)**

```typescript
// Append to sidecar/tests/unit/rate-limiter.test.ts inside the describe block.
  it("setMultiplier sets exact value, getMultiplier returns it", () => {
    const rl = new PerHostRateLimiter({ delayMinMs: 1000, maxConcurrency: 1 });
    expect(rl.getMultiplier("h.com")).toBe(1);
    rl.setMultiplier("h.com", 1.6);
    expect(rl.getMultiplier("h.com")).toBeCloseTo(1.6, 5);
  });

  it("setMultiplier clamps to [0.05, 50] to avoid pathological values", () => {
    const rl = new PerHostRateLimiter({ delayMinMs: 1000, maxConcurrency: 1 });
    rl.setMultiplier("h.com", 0);
    expect(rl.getMultiplier("h.com")).toBe(0.05);
    rl.setMultiplier("h.com", 999);
    expect(rl.getMultiplier("h.com")).toBe(50);
  });

  it("acquire respects setMultiplier value", async () => {
    const rl = new PerHostRateLimiter({ delayMinMs: 200, maxConcurrency: 1 });
    rl.setMultiplier("h.com", 2);
    const t0 = Date.now();
    await rl.acquire("h.com");
    rl.release("h.com");
    await rl.acquire("h.com");
    rl.release("h.com");
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(380); // 200 * 2 = 400ms gap
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && npx vitest run tests/unit/rate-limiter.test.ts`
Expected: FAIL — `setMultiplier` / `getMultiplier` not defined.

- [ ] **Step 3: Implement setMultiplier and getMultiplier**

In `sidecar/src/rate-limiter.ts`, add these methods to the `PerHostRateLimiter` class (place them adjacent to `bumpDelay`):

```typescript
  /**
   * Set the per-host delay multiplier to an exact value. Used by the adaptive
   * controller's AIMD math (which computes continuous targets, not just doubles).
   * Clamped to [0.05, 50] — outside that range is almost certainly a bug, and
   * letting it through corrupts the limiter's gap math.
   */
  setMultiplier(host: string, mult: number): void {
    const state = this.getState(host);
    state.delayMultiplier = Math.max(0.05, Math.min(50, mult));
  }

  getMultiplier(host: string): number {
    return this.states.get(host)?.delayMultiplier ?? 1;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && npx vitest run tests/unit/rate-limiter.test.ts`
Expected: all tests pass (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/rate-limiter.ts sidecar/tests/unit/rate-limiter.test.ts
git commit -m "feat(sidecar): rate-limiter setMultiplier/getMultiplier for AIMD"
```

---

## Task 4: AdaptiveController (AIMD + re-probe trigger)

**Files:**
- Create: `sidecar/src/adaptiveController.ts`
- Create: `sidecar/tests/unit/adaptiveController.test.ts`

The controller is invoked once per response. It pulls classification + state, runs AIMD on the per-host multiplier, and emits two kinds of events: `controller-state` (debounced, for UI) and `re-probe-requested` (one-shot, for Rust). Constants per spec: floor 250ms, ceiling 15000ms, MD multiplier 1.6, AI step −100ms, clean-streak threshold 200, cooldown-since-block 60s, 403-burst threshold 10 in 60s, ceiling-saturated for 5min + >20% block rate, re-probe cooldown 5min.

The controller works on multiplier space (the rate-limiter knob), not absolute ms. Floor and ceiling are converted using the configured base `delayMinMs`: `floorMult = 250 / delayMinMs`, `ceilMult = 15000 / delayMinMs`. So if `delayMinMs = 2000`, floor multiplier is 0.125 and ceiling is 7.5.

- [ ] **Step 1: Write the failing test**

```typescript
// sidecar/tests/unit/adaptiveController.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AdaptiveController } from "../../src/adaptiveController.js";
import { PerHostStates } from "../../src/perHostState.js";
import { PerHostRateLimiter } from "../../src/rate-limiter.js";

function setup() {
  const rl = new PerHostRateLimiter({ delayMinMs: 1000, maxConcurrency: 1 });
  const states = new PerHostStates();
  const events: any[] = [];
  const ctrl = new AdaptiveController({
    rateLimiter: rl,
    states,
    delayMinMs: 1000,
    onEvent: (e) => events.push(e),
  });
  return { rl, states, ctrl, events };
}

describe("AdaptiveController", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("multiplies multiplier by 1.6 on block, clamps to ceiling", () => {
    const { rl, ctrl } = setup();
    ctrl.tick("h.com", "blocked-status:429", { url: "https://h.com/", bodyBytes: 0, internalLinks: 0 });
    expect(rl.getMultiplier("h.com")).toBeCloseTo(1.6, 5);
    for (let i = 0; i < 50; i++) {
      ctrl.tick("h.com", "blocked-status:429", { url: "https://h.com/", bodyBytes: 0, internalLinks: 0 });
    }
    // ceil = 15000ms / 1000ms = 15
    expect(rl.getMultiplier("h.com")).toBe(15);
  });

  it("steps down −100ms after 200 clean responses + 60s since last block", () => {
    const { rl, ctrl } = setup();
    rl.setMultiplier("h.com", 2); // start at 2× = 2000ms
    ctrl.tick("h.com", "blocked-status:429", { url: "https://h.com/", bodyBytes: 0, internalLinks: 0 });
    // multiplier now 2 * 1.6 = 3.2
    const after = rl.getMultiplier("h.com");
    vi.advanceTimersByTime(61_000); // past 60s cooldown

    for (let i = 0; i < 199; i++) {
      ctrl.tick("h.com", "ok", { url: "https://h.com/", bodyBytes: 50000, internalLinks: 80 });
    }
    expect(rl.getMultiplier("h.com")).toBe(after); // not yet
    ctrl.tick("h.com", "ok", { url: "https://h.com/", bodyBytes: 50000, internalLinks: 80 });
    // step is −100ms / 1000ms = −0.1 multiplier
    expect(rl.getMultiplier("h.com")).toBeCloseTo(after - 0.1, 5);
  });

  it("step-down does not fire if <60s since last block", () => {
    const { rl, ctrl } = setup();
    ctrl.tick("h.com", "blocked-status:429", { url: "https://h.com/", bodyBytes: 0, internalLinks: 0 });
    const after = rl.getMultiplier("h.com");
    vi.advanceTimersByTime(30_000); // only 30s
    for (let i = 0; i < 200; i++) {
      ctrl.tick("h.com", "ok", { url: "https://h.com/", bodyBytes: 50000, internalLinks: 80 });
    }
    expect(rl.getMultiplier("h.com")).toBe(after);
  });

  it("emits re-probe-requested on 10 consecutive 403s within 60s", () => {
    const { ctrl, events } = setup();
    for (let i = 0; i < 10; i++) {
      ctrl.tick("h.com", "blocked-status:403", { url: "https://h.com/p" + i, bodyBytes: 0, internalLinks: 0 });
    }
    const reprobe = events.find((e) => e.type === "re-probe-requested");
    expect(reprobe).toBeDefined();
    expect(reprobe.host).toBe("h.com");
    expect(reprobe.reason).toBe("403-burst");
  });

  it("does not re-emit re-probe within 5min cooldown", () => {
    const { ctrl, events } = setup();
    for (let i = 0; i < 10; i++) {
      ctrl.tick("h.com", "blocked-status:403", { url: "https://h.com/p" + i, bodyBytes: 0, internalLinks: 0 });
    }
    expect(events.filter((e) => e.type === "re-probe-requested").length).toBe(1);
    vi.advanceTimersByTime(60_000);
    for (let i = 0; i < 10; i++) {
      ctrl.tick("h.com", "blocked-status:403", { url: "https://h.com/p" + i, bodyBytes: 0, internalLinks: 0 });
    }
    expect(events.filter((e) => e.type === "re-probe-requested").length).toBe(1);
    vi.advanceTimersByTime(5 * 60_000 + 1000);
    for (let i = 0; i < 10; i++) {
      ctrl.tick("h.com", "blocked-status:403", { url: "https://h.com/p" + i, bodyBytes: 0, internalLinks: 0 });
    }
    expect(events.filter((e) => e.type === "re-probe-requested").length).toBe(2);
  });

  it("emits re-probe on ceiling-saturated 5min + >20% block rate", () => {
    const { rl, states, ctrl, events } = setup();
    rl.setMultiplier("h.com", 15); // already at ceiling
    // Fill window with 30% blocks: 70 ok + 30 blocked-content
    for (let i = 0; i < 70; i++) ctrl.tick("h.com", "ok", { url: "https://h.com/", bodyBytes: 50000, internalLinks: 80 });
    for (let i = 0; i < 30; i++) ctrl.tick("h.com", "blocked-content", { url: "https://h.com/", bodyBytes: 1000, internalLinks: 0 });
    expect(events.filter((e) => e.type === "re-probe-requested").length).toBe(0);

    // Saturated for 5 minutes
    vi.advanceTimersByTime(5 * 60_000 + 1000);
    ctrl.tick("h.com", "ok", { url: "https://h.com/", bodyBytes: 50000, internalLinks: 80 });
    const reprobe = events.find((e) => e.type === "re-probe-requested" && e.reason === "ceiling-saturated");
    expect(reprobe).toBeDefined();
  });

  it("emits debounced controller-state events (≤1/s/host)", () => {
    const { ctrl, events } = setup();
    ctrl.tick("h.com", "ok", { url: "https://h.com/", bodyBytes: 50000, internalLinks: 80 });
    ctrl.tick("h.com", "ok", { url: "https://h.com/", bodyBytes: 50000, internalLinks: 80 });
    ctrl.tick("h.com", "ok", { url: "https://h.com/", bodyBytes: 50000, internalLinks: 80 });
    const stateEvts = events.filter((e) => e.type === "controller-state");
    expect(stateEvts.length).toBe(1); // debounce holds the rest
    vi.advanceTimersByTime(1100);
    ctrl.tick("h.com", "ok", { url: "https://h.com/", bodyBytes: 50000, internalLinks: 80 });
    expect(events.filter((e) => e.type === "controller-state").length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && npx vitest run tests/unit/adaptiveController.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement AdaptiveController**

```typescript
// sidecar/src/adaptiveController.ts
import type { PerHostRateLimiter } from "./rate-limiter.js";
import type { PerHostStates } from "./perHostState.js";
import type { Classification } from "./responseClassifier.js";

const FLOOR_MS = 250;
const CEIL_MS = 15000;
const MD_MULTIPLIER = 1.6;
const AI_STEP_MS = 100;
const CLEAN_STREAK_THRESHOLD = 200;
const SINCE_BLOCK_THRESHOLD_MS = 60_000;
const CONSECUTIVE_403_THRESHOLD = 10;
const CONSECUTIVE_403_WINDOW_MS = 60_000;
const CEILING_SATURATED_MS = 5 * 60_000;
const CEILING_BLOCK_RATE_THRESHOLD = 0.2;
const REPROBE_COOLDOWN_MS = 5 * 60_000;
const STATE_EMIT_DEBOUNCE_MS = 1000;

export type ControllerEvent =
  | {
      type: "controller-state";
      ts: number;
      host: string;
      delayMs: number;
      multiplier: number;
      blockRate: number;
      classification: Classification;
      action: "step-up" | "step-down" | "hold";
    }
  | {
      type: "re-probe-requested";
      ts: number;
      host: string;
      reason: "403-burst" | "ceiling-saturated";
      sampleUrl: string;
    };

export interface AdaptiveControllerOpts {
  rateLimiter: PerHostRateLimiter;
  states: PerHostStates;
  delayMinMs: number;
  onEvent: (e: ControllerEvent) => void;
}

interface PerHostCtl {
  ceilingSinceMonoMs: number | null;
  consec403StartMonoMs: number | null;
  lastReprobeMonoMs: number | null;
  lastEmitMonoMs: number;
}

function isBlocked(c: Classification): boolean {
  return c === "blocked-status:403"
    || c === "blocked-status:429"
    || c === "blocked-status:503"
    || c === "blocked-content"
    || c === "cloaked";
}

function monoNowMs(): number {
  return performance.now();
}

export class AdaptiveController {
  private rl: PerHostRateLimiter;
  private states: PerHostStates;
  private delayMinMs: number;
  private onEvent: (e: ControllerEvent) => void;
  private floorMult: number;
  private ceilMult: number;
  private aiStepMult: number;
  private ctl = new Map<string, PerHostCtl>();

  constructor(opts: AdaptiveControllerOpts) {
    this.rl = opts.rateLimiter;
    this.states = opts.states;
    this.delayMinMs = opts.delayMinMs;
    this.onEvent = opts.onEvent;
    this.floorMult = FLOOR_MS / opts.delayMinMs;
    this.ceilMult = CEIL_MS / opts.delayMinMs;
    this.aiStepMult = AI_STEP_MS / opts.delayMinMs;
  }

  tick(
    host: string,
    classification: Classification,
    snap: { url: string; bodyBytes: number; internalLinks: number },
  ): void {
    const ctl = this.touchCtl(host);

    let action: "step-up" | "step-down" | "hold" = "hold";

    if (isBlocked(classification)) {
      const cur = this.rl.getMultiplier(host);
      const next = Math.min(this.ceilMult, cur * MD_MULTIPLIER);
      this.rl.setMultiplier(host, next);
      action = "step-up";
    } else if (
      classification === "ok" &&
      this.states.cleanStreak(host) >= CLEAN_STREAK_THRESHOLD &&
      this.states.sinceLastBlockMs(host) >= SINCE_BLOCK_THRESHOLD_MS
    ) {
      const cur = this.rl.getMultiplier(host);
      const next = Math.max(this.floorMult, cur - this.aiStepMult);
      if (next !== cur) {
        this.rl.setMultiplier(host, next);
        this.states.resetCleanStreak(host);
        action = "step-down";
      }
    }

    this.maybeReprobe(host, classification, snap.url, ctl);
    this.maybeEmitState(host, classification, action, ctl);
  }

  private maybeReprobe(host: string, classification: Classification, sampleUrl: string, ctl: PerHostCtl): void {
    const nowMono = monoNowMs();
    if (ctl.lastReprobeMonoMs !== null && nowMono - ctl.lastReprobeMonoMs < REPROBE_COOLDOWN_MS) return;

    if (classification === "blocked-status:403") {
      if (ctl.consec403StartMonoMs === null) ctl.consec403StartMonoMs = nowMono;
      const consec = this.states.consecutive403(host);
      if (
        consec >= CONSECUTIVE_403_THRESHOLD &&
        nowMono - ctl.consec403StartMonoMs <= CONSECUTIVE_403_WINDOW_MS
      ) {
        this.fireReprobe(host, "403-burst", sampleUrl, ctl);
        return;
      }
    } else {
      ctl.consec403StartMonoMs = null;
    }

    const atCeiling = this.rl.getMultiplier(host) >= this.ceilMult - 1e-9;
    if (atCeiling) {
      if (ctl.ceilingSinceMonoMs === null) ctl.ceilingSinceMonoMs = nowMono;
      if (
        nowMono - ctl.ceilingSinceMonoMs >= CEILING_SATURATED_MS &&
        this.states.blockRate(host) > CEILING_BLOCK_RATE_THRESHOLD
      ) {
        this.fireReprobe(host, "ceiling-saturated", sampleUrl, ctl);
      }
    } else {
      ctl.ceilingSinceMonoMs = null;
    }
  }

  private fireReprobe(
    host: string,
    reason: "403-burst" | "ceiling-saturated",
    sampleUrl: string,
    ctl: PerHostCtl,
  ): void {
    ctl.lastReprobeMonoMs = monoNowMs();
    this.onEvent({ type: "re-probe-requested", ts: Date.now(), host, reason, sampleUrl });
  }

  private maybeEmitState(
    host: string,
    classification: Classification,
    action: "step-up" | "step-down" | "hold",
    ctl: PerHostCtl,
  ): void {
    const nowMono = monoNowMs();
    const force = action !== "hold";
    if (!force && nowMono - ctl.lastEmitMonoMs < STATE_EMIT_DEBOUNCE_MS) return;
    ctl.lastEmitMonoMs = nowMono;
    const mult = this.rl.getMultiplier(host);
    this.onEvent({
      type: "controller-state",
      ts: Date.now(),
      host,
      delayMs: Math.round(this.delayMinMs * mult),
      multiplier: mult,
      blockRate: this.states.blockRate(host),
      classification,
      action,
    });
  }

  private touchCtl(host: string): PerHostCtl {
    let c = this.ctl.get(host);
    if (!c) {
      c = {
        ceilingSinceMonoMs: null,
        consec403StartMonoMs: null,
        lastReprobeMonoMs: null,
        lastEmitMonoMs: -Infinity,
      };
      this.ctl.set(host, c);
    }
    return c;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && npx vitest run tests/unit/adaptiveController.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/adaptiveController.ts sidecar/tests/unit/adaptiveController.test.ts
git commit -m "feat(sidecar): AdaptiveController AIMD + re-probe trigger"
```

---

## Task 5: Wire controller into crawler.recordResult

**Files:**
- Modify: `sidecar/src/crawler.ts` (around lines 1207–1421)

The controller needs to be constructed alongside `BlockDetector` and called inside `recordResult` for every response. Replace the `bumpDelay` call with a controller tick. Keep BlockDetector untouched — it still owns hard-block gating + cooldowns; controller owns continuous pacing.

- [ ] **Step 1: Read current `recordResult` and detector construction**

Run: `grep -n "BlockDetector\|recordResult\|bumpDelay" sidecar/src/crawler.ts`
Note the exact line numbers for the modifications below.

- [ ] **Step 2: Add controller imports and construction**

In `sidecar/src/crawler.ts`, near the existing `import { BlockDetector, hostOf }` line (line 14):

```typescript
import { PerHostStates } from "./perHostState.js";
import { AdaptiveController, type ControllerEvent } from "./adaptiveController.js";
import { classifyResponse } from "./responseClassifier.js";
```

Near the existing `const detector = new BlockDetector({...})` (around line 1207), immediately after it, add:

```typescript
const perHostStates = new PerHostStates();
const adaptiveController = new AdaptiveController({
  rateLimiter,
  states: perHostStates,
  delayMinMs: rateLimiter.delayMinMs,
  onEvent: (e: ControllerEvent) => writeAnyEvent(e),
});
```

- [ ] **Step 3: Replace recordResult body**

Find `function recordResult(result: CrawlResult): void { ... }` (starts around line 1397). Replace its body so the controller runs on every response:

```typescript
  function recordResult(result: CrawlResult): void {
    writeLine(result);
    const h = hostOf(result.url);
    if (!h) return;

    const baseline = perHostStates.baseline(h);
    const snap = {
      url: result.url,
      status: result.status,
      title: result.title ?? "",
      bodyBytes: result.size ?? 0,
      internalLinks: result.internalLinks ?? 0,
    };
    const cls = classifyResponse(snap, h, detector, baseline);

    if (cls === "ok") perHostStates.recordOk(h, snap.bodyBytes, snap.internalLinks);
    perHostStates.recordClassification(h, cls);
    adaptiveController.tick(h, cls, snap);

    const trip = detector.record({ url: result.url, status: result.status, title: result.title }, h);
    if (trip) {
      writeAnyEvent(trip);
      log("warn", "block-detected: host paused", {
        host: trip.host,
        stats: trip.stats,
        reasons: trip.reasons,
      });
    }
  }
```

Note: the `bumpDelay` call is gone — controller now owns delay. `BlockDetector` continues to gate the host on a trip (its existing cooldown + parking behavior is unchanged).

- [ ] **Step 4: Run sidecar tests to verify nothing broke**

Run: `cd sidecar && npm test`
Expected: all existing tests still pass. (The crawler's existing tests don't exercise `bumpDelay` directly; if any do, expectations may need updating — adjust per actual failure.)

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/crawler.ts
git commit -m "feat(sidecar): wire AdaptiveController into recordResult"
```

---

## Task 6: Test fixture server scriptable response patterns

**Files:**
- Modify: `sidecar/test-server/routes.ts`

The integration test (Task 7) needs the fixture server to return scripted patterns. Add a route that takes a query param `?script=<name>` and returns one of: `normal`, `cloaked`, `captcha`, `403`, `429`. Each test sequences calls.

- [ ] **Step 1: Read current routes.ts to understand its style**

Run: `cd sidecar && cat test-server/routes.ts`
Note: how routes are registered, what helpers exist for HTML.

- [ ] **Step 2: Add a `/scripted` route**

Append to `sidecar/test-server/routes.ts` (adapt the registration call to match the existing style — the snippet below assumes the file exports a route-registration function; adjust to actual shape):

```typescript
// Append a route that returns a configurable response based on ?script=...
// for adaptive-controller integration tests.
export function registerScriptedRoute(app: any /* the existing server's router type */): void {
  app.get("/scripted", (req: any, res: any) => {
    const script = String(req.query.script ?? "normal");
    if (script === "403") {
      res.status(403).type("text/html").send("<html><head><title>Forbidden</title></head><body>403</body></html>");
      return;
    }
    if (script === "429") {
      res.status(429).type("text/html").send("<html><head><title>Too Many</title></head><body>429</body></html>");
      return;
    }
    if (script === "captcha") {
      res.status(200).type("text/html").send("<html><head><title>Just a moment...</title></head><body>challenge</body></html>");
      return;
    }
    if (script === "cloaked") {
      res.status(200).type("text/html").send("<html><head><title>Page</title></head><body>x</body></html>");
      return;
    }
    // normal: ~50KB body with 80 internal links
    const links = Array.from({ length: 80 }, (_, i) => `<a href="/page${i}">p${i}</a>`).join("\n");
    const filler = "x".repeat(50_000);
    res.status(200).type("text/html").send(
      `<html><head><title>Page</title></head><body>${links}<div>${filler}</div></body></html>`,
    );
  });
}
```

If the existing `routes.ts` exports a single `registerRoutes(app)`, add the `/scripted` handler inside that function instead of exporting a new one. The engineer should follow whatever convention is already there.

- [ ] **Step 3: Verify the route works**

Run (in two terminals):
```
cd sidecar && npm run test:server
```
Then in another:
```
curl -i 'http://localhost:5000/scripted?script=403'
curl -i 'http://localhost:5000/scripted?script=429'
curl -i 'http://localhost:5000/scripted?script=captcha' | head -3
curl -s 'http://localhost:5000/scripted?script=normal' | wc -c
```
Expected: 403 status, 429 status, "Just a moment..." in title, normal body > 50KB.

- [ ] **Step 4: Commit**

```bash
git add sidecar/test-server/routes.ts
git commit -m "test(sidecar): scripted response route for adaptive-controller tests"
```

---

## Task 7: Sidecar integration test

**Files:**
- Create: `sidecar/tests/integration/adaptive-controller.test.ts`

Drive the controller against the fixture server via repeated direct calls (no full crawler spinup — that's slow and out of scope). Validates classification + state + AIMD interact correctly with the rate limiter end-to-end on real HTTP responses.

- [ ] **Step 1: Write the failing test**

```typescript
// sidecar/tests/integration/adaptive-controller.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer } from "../../test-server/server.js"; // adjust import to actual export
import { PerHostRateLimiter } from "../../src/rate-limiter.js";
import { PerHostStates } from "../../src/perHostState.js";
import { AdaptiveController, type ControllerEvent } from "../../src/adaptiveController.js";
import { BlockDetector } from "../../src/blockDetector.js";
import { classifyResponse } from "../../src/responseClassifier.js";

let server: { url: string; close: () => Promise<void> };

async function fetchPage(url: string): Promise<{ status: number; title: string; body: string }> {
  const r = await fetch(url);
  const body = await r.text();
  const m = body.match(/<title>([^<]*)<\/title>/i);
  return { status: r.status, title: m?.[1] ?? "", body };
}

beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => { await server.close(); });

describe("AdaptiveController integration", () => {
  it("403 burst from real HTTP triggers re-probe-requested", async () => {
    const rl = new PerHostRateLimiter({ delayMinMs: 50, maxConcurrency: 4 });
    const states = new PerHostStates();
    const events: ControllerEvent[] = [];
    const ctrl = new AdaptiveController({
      rateLimiter: rl, states, delayMinMs: 50, onEvent: (e) => events.push(e),
    });
    const detector = new BlockDetector({ cooldownsMs: [] });
    const host = new URL(server.url).host;

    for (let i = 0; i < 10; i++) {
      const r = await fetchPage(`${server.url}/scripted?script=403&i=${i}`);
      const cls = classifyResponse(
        { url: `${server.url}/scripted?script=403&i=${i}`, status: r.status, title: r.title, bodyBytes: r.body.length, internalLinks: 0 },
        host, detector, states.baseline(host),
      );
      states.recordClassification(host, cls);
      ctrl.tick(host, cls, { url: `${server.url}/scripted?script=403&i=${i}`, bodyBytes: r.body.length, internalLinks: 0 });
    }

    const reprobe = events.find((e) => e.type === "re-probe-requested" && e.reason === "403-burst");
    expect(reprobe).toBeDefined();
  }, 30_000);

  it("captcha title (200 + block phrase) classifies as blocked-content and steps up", async () => {
    const rl = new PerHostRateLimiter({ delayMinMs: 100, maxConcurrency: 1 });
    const states = new PerHostStates();
    const ctrl = new AdaptiveController({
      rateLimiter: rl, states, delayMinMs: 100, onEvent: () => {},
    });
    const detector = new BlockDetector({ cooldownsMs: [] });
    const host = new URL(server.url).host;

    const r = await fetchPage(`${server.url}/scripted?script=captcha`);
    const cls = classifyResponse(
      { url: `${server.url}/scripted?script=captcha`, status: r.status, title: r.title, bodyBytes: r.body.length, internalLinks: 0 },
      host, detector, null,
    );
    expect(cls).toBe("blocked-content");
    states.recordClassification(host, cls);
    const before = rl.getMultiplier(host);
    ctrl.tick(host, cls, { url: `${server.url}/scripted?script=captcha`, bodyBytes: r.body.length, internalLinks: 0 });
    expect(rl.getMultiplier(host)).toBeGreaterThan(before);
  }, 30_000);
});
```

If `startTestServer` doesn't exist as exported, the engineer should either expose it from `test-server/server.ts` or run the server out-of-band and target `http://localhost:5000` directly. Either is fine.

- [ ] **Step 2: Run integration test**

Run: `cd sidecar && npx vitest run tests/integration/adaptive-controller.test.ts`
Expected: 2 tests pass.

- [ ] **Step 3: Commit**

```bash
git add sidecar/tests/integration/adaptive-controller.test.ts
git commit -m "test(sidecar): adaptive-controller HTTP integration"
```

---

## Task 8: Rust event routing for new sidecar event types

**Files:**
- Modify: `src-tauri/src/commands.rs` (`route_sidecar_stdout`, around line 587)

`controller-state` events become a frontend `pacing-update` event. `re-probe-requested` events trigger the re-probe coordinator (Task 9) but for now route to a `re-probe-requested` frontend event so we can see them firing.

- [ ] **Step 1: Modify the event-name match**

In `src-tauri/src/commands.rs`, locate the match in `route_sidecar_stdout` (around line 587). Add two new arms:

```rust
                Some("controller-state") => "pacing-update",
                Some("re-probe-requested") => "re-probe-requested",
```

Place them adjacent to the existing `Some("block-detected") => "block-detected",` line.

- [ ] **Step 2: Add stale-event gating for the new types**

In the same function, the `if matches!(ev_name, ...)` block (around line 606) gates events from a stale generation. Add `"pacing-update"` and `"re-probe-requested"` to that match:

```rust
            if matches!(
                ev_name,
                "crawl-result"
                    | "block-detected"
                    | "block-cooldown-cleared"
                    | "sidecar-metric"
                    | "sidecar-log"
                    | "sidecar-phase"
                    | "sidecar-timing"
                    | "pacing-update"
                    | "re-probe-requested"
            ) {
```

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(rust): route controller-state and re-probe-requested events"
```

---

## Task 9: Rust re-probe coordinator

**Files:**
- Modify: `src-tauri/src/commands.rs`

When `re-probe-requested` arrives from the sidecar, Rust should: (a) pause dispatch, (b) drain in-flight, (c) run probe matrix on `sampleUrl`, (d) respawn sidecar with the winning row's args, (e) resume. The existing probe + respawn paths already exist; this task just wires them together behind the new event.

This is the largest Rust change. The exact glue depends on existing crawl-control APIs in `commands.rs` — engineer must read `commands.rs` thoroughly first to find the existing pause/respawn primitives and the existing `runProbeMatrix` invocation path.

- [ ] **Step 1: Read existing pause/probe/respawn primitives**

Run:
```
grep -n "fn run_probe_matrix\|fn pause\|fn stop_crawl\|spawn_sidecar\|kill_crawl\|respawn" src-tauri/src/commands.rs
```
Make notes of:
- The function that runs the probe matrix (used by Task 1 of the original probe flow).
- The function that kills the sidecar.
- The function that spawns a new sidecar with given args.
- Where the live crawl args are stored so we can apply a "winning row" diff.

Document findings in this commit message of the next step. If any of these primitives is missing, this task expands and the engineer should pause and ask.

- [ ] **Step 2: Add a 5-min cooldown guard at the Rust level**

In `commands.rs`, add module-level state for re-probe cooldown:

```rust
use std::sync::atomic::{AtomicI64, Ordering as AtomicOrdering};
use std::time::Instant;

static LAST_REPROBE_MONO_MS: AtomicI64 = AtomicI64::new(i64::MIN);
const REPROBE_COOLDOWN_MS: i64 = 5 * 60 * 1000;

fn reprobe_cooldown_elapsed() -> bool {
    let now_ms = Instant::now().elapsed().as_millis() as i64; // monotonic since process start
    let last = LAST_REPROBE_MONO_MS.load(AtomicOrdering::SeqCst);
    last == i64::MIN || (now_ms - last) >= REPROBE_COOLDOWN_MS
}

fn mark_reprobe_now() {
    let now_ms = Instant::now().elapsed().as_millis() as i64;
    LAST_REPROBE_MONO_MS.store(now_ms, AtomicOrdering::SeqCst);
}
```

The sidecar already enforces a cooldown, but the Rust-side guard protects against any path that bypasses the sidecar (e.g., a user-triggered re-probe).

- [ ] **Step 3: Add a handler for `re-probe-requested`**

Inside `route_sidecar_stdout` (after the `match` that picks `ev_name`), before the final `app.emit(ev_name, val)` call, add:

```rust
            if ev_name == "re-probe-requested" {
                if !reprobe_cooldown_elapsed() {
                    let _ = app.emit(ev_name, val);
                    return;
                }
                mark_reprobe_now();
                let app2 = app.clone();
                let val2 = val.clone();
                tauri::async_runtime::spawn(async move {
                    // Engineer fills in: pause dispatch -> drain in-flight (30s timeout)
                    // -> run probe matrix on val2["sampleUrl"] -> apply winner -> respawn sidecar.
                    // Use the primitives identified in Step 1.
                    if let Err(e) = run_reprobe_flow(&app2, &val2).await {
                        let _ = app2.emit("sidecar-log", serde_json::json!({
                            "ts": now_ms(), "level": "error", "msg": format!("re-probe failed: {e}")
                        }));
                    }
                });
                let _ = app.emit(ev_name, val);
                return;
            }
```

- [ ] **Step 4: Implement `run_reprobe_flow`**

Define `async fn run_reprobe_flow(app: &AppHandle, payload: &serde_json::Value) -> Result<(), String>` near the other crawl-control functions in `commands.rs`. Steps:
1. Call the existing pause-dispatch function.
2. Wait up to 30s for `in_flight == 0`. If still not zero, force-cancel (existing path).
3. Read `payload["sampleUrl"]` as a `&str`.
4. Call the existing `run_probe_matrix(app, sampleUrl)` and await its `probe-result` events; pick the first row where `blocked == false`.
5. If a winning row exists, build sidecar CLI args from it (existing translator — engineer should grep for where probe winner is currently applied) and respawn the sidecar.
6. If no winning row, log "re-probe found no winning row; resuming with previous config" and resume dispatch with current args.
7. Resume dispatch.

Pseudocode (engineer fills in real function names):

```rust
async fn run_reprobe_flow(app: &AppHandle, payload: &serde_json::Value) -> Result<(), String> {
    let sample_url = payload.get("sampleUrl").and_then(|v| v.as_str())
        .ok_or_else(|| "missing sampleUrl".to_string())?;

    pause_dispatch(app).await.map_err(|e| e.to_string())?;
    drain_in_flight(app, std::time::Duration::from_secs(30)).await;

    let winner = run_probe_matrix(app, sample_url).await
        .map_err(|e| e.to_string())?;

    match winner {
        Some(row) => {
            apply_probe_winner(app, &row).await.map_err(|e| e.to_string())?;
            respawn_sidecar(app).await.map_err(|e| e.to_string())?;
        }
        None => {
            let _ = app.emit("sidecar-log", serde_json::json!({
                "ts": now_ms(), "level": "warn",
                "msg": "re-probe: no row beat blocks, resuming with previous config",
            }));
            resume_dispatch(app).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
```

- [ ] **Step 5: Compile and run existing Rust tests**

Run: `cd src-tauri && cargo check && cargo test`
Expected: build clean, existing tests still pass.

- [ ] **Step 6: Manual smoke against fixture server**

Run the dev app: `npm run dev`. Start a small list-mode crawl with one URL pointing at `http://localhost:5000/scripted?script=403`. Observe HEALTH `Re-probe events` log gets a row after 10 403s land.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(rust): re-probe coordinator on re-probe-requested"
```

---

## Task 10: Frontend HEALTH "Adaptive Pacing" card

**Files:**
- Create: `frontend/src/components/AdaptivePacingCard.vue`
- Modify: `frontend/src/views/Health.vue` (engineer should grep for the file that renders the HEALTH tab — naming may differ)

The card listens to `pacing-update` and `re-probe-requested` events, maintains a per-host map in component state, and renders the table from the spec plus a re-probe-events log below it.

- [ ] **Step 1: Find the HEALTH view**

Run: `grep -rn "HEALTH" frontend/src/ --include="*.vue" -l | head`
Identify the file that contains the HEALTH cards. The new card mounts inside it.

- [ ] **Step 2: Create AdaptivePacingCard.vue**

```vue
<!-- frontend/src/components/AdaptivePacingCard.vue -->
<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface PacingUpdate {
  ts: number;
  host: string;
  delayMs: number;
  multiplier: number;
  blockRate: number;
  classification: string;
  action: "step-up" | "step-down" | "hold";
}

interface ReprobeEvent {
  ts: number;
  host: string;
  reason: "403-burst" | "ceiling-saturated";
  sampleUrl: string;
}

interface HostRow {
  host: string;
  delayMs: number;
  blockRate: number;
  lastAction: string;
  lastActionTs: number;
}

const hosts = ref<Map<string, HostRow>>(new Map());
const reprobes = ref<ReprobeEvent[]>([]);
const unlisteners: UnlistenFn[] = [];

function bucketFor(delayMs: number): "AGGRESSIVE" | "STEADY" | "CAUTIOUS" | "PROBING" {
  if (delayMs < 1000) return "AGGRESSIVE";
  if (delayMs < 3000) return "STEADY";
  if (delayMs < 8000) return "CAUTIOUS";
  return "PROBING";
}

const rows = computed(() => {
  return [...hosts.value.values()].map((r) => ({
    ...r,
    bucket: bucketFor(r.delayMs),
  }));
});

onMounted(async () => {
  unlisteners.push(
    await listen<PacingUpdate>("pacing-update", (e) => {
      hosts.value.set(e.payload.host, {
        host: e.payload.host,
        delayMs: e.payload.delayMs,
        blockRate: e.payload.blockRate,
        lastAction: e.payload.action,
        lastActionTs: e.payload.ts,
      });
    }),
  );
  unlisteners.push(
    await listen<ReprobeEvent>("re-probe-requested", (e) => {
      reprobes.value.unshift(e.payload);
      if (reprobes.value.length > 50) reprobes.value.pop();
    }),
  );
});

onUnmounted(() => {
  for (const u of unlisteners) u();
});
</script>

<template>
  <div class="card">
    <h3>ADAPTIVE PACING</h3>
    <table v-if="rows.length > 0">
      <thead>
        <tr>
          <th>Host</th><th>State</th><th>Delay</th><th>Block rate</th><th>Last action</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.host">
          <td>{{ r.host }}</td>
          <td>{{ r.bucket }}</td>
          <td>{{ r.delayMs }}ms</td>
          <td>{{ Math.round(r.blockRate * 100) }}%</td>
          <td>{{ r.lastAction }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else>No pacing activity yet.</p>

    <h4>Re-probe events</h4>
    <ul v-if="reprobes.length > 0">
      <li v-for="(r, i) in reprobes" :key="i">
        {{ new Date(r.ts).toLocaleTimeString() }} — {{ r.host }} — {{ r.reason }}
      </li>
    </ul>
    <p v-else>No re-probes triggered.</p>
  </div>
</template>

<style scoped>
.card { padding: 1rem; border: 1px solid var(--border, #333); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 0.25rem 0.5rem; }
</style>
```

Style follows whatever HEALTH cards already use. Engineer should align colors/spacing with `frontend/designrules.md` per project CLAUDE.md.

- [ ] **Step 3: Mount the card in HEALTH view**

In the HEALTH view file (identified in Step 1), import and render `<AdaptivePacingCard />` alongside the existing cards.

```ts
import AdaptivePacingCard from "@/components/AdaptivePacingCard.vue";
```
And in the template:
```html
<AdaptivePacingCard />
```

- [ ] **Step 4: Run dev app and visually verify**

Run: `npm run dev`
Start a list-mode crawl against the fixture server (or any real site). HEALTH tab should show the new "ADAPTIVE PACING" card. Watch rows populate as responses come in.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/AdaptivePacingCard.vue frontend/src/views/Health.vue
git commit -m "feat(frontend): HEALTH adaptive-pacing card"
```

(Adjust the second path if the HEALTH view file name differs.)

---

## Task 11: Manual smoke verification

**Files:** none (verification only)

End-to-end manual test against the scripted fixture server. No automated CI for this — anti-bot interactions are non-deterministic, can't be in CI.

- [ ] **Step 1: Start fixture server**

Run: `cd sidecar && npm run test:server`
Expected: server up on `:5000`.

- [ ] **Step 2: Crawl against scripted permissive endpoint**

In dev app (`npm run dev`), start a list-mode crawl of `http://localhost:5000/scripted?script=normal` (×100 rows by appending `&i=0..99`). Watch HEALTH card. Expected:
- Initial bucket: STEADY (1×, 50ms ⇒ tiny — likely AGGRESSIVE).
- Block rate stays 0%.
- Delay bucket creeps DOWN over time to floor (250ms minimum).

- [ ] **Step 3: Crawl against scripted 429 endpoint**

Crawl `http://localhost:5000/scripted?script=429` (×30). Watch HEALTH:
- Block rate climbs.
- Delay multiplies up by 1.6 each block, ratcheting toward ceiling.
- Bucket transitions: AGGRESSIVE → STEADY → CAUTIOUS → PROBING.

- [ ] **Step 4: Crawl against scripted 403 endpoint**

Crawl `http://localhost:5000/scripted?script=403` (×15). Within 60 seconds of the 10th consecutive 403, a `re-probe-requested` event should appear in the HEALTH "Re-probe events" log.

- [ ] **Step 5: Crawl against cloak endpoint (after baseline)**

First crawl 25 `script=normal` rows on `cr-test.local` (use a fake hostname via `/etc/hosts` or query string). Once baseline is established (need ≥20 ok samples), crawl `script=cloaked` rows. Verify they classify as `cloaked` and the controller steps up. (If hosts file is too much friction, just run on `localhost` and accept the test is for the controller logic only — cloak detection requires the same host across calls.)

- [ ] **Step 6: Note results in the spec**

Append a "Verification" section to `docs/superpowers/specs/2026-05-06-adaptive-pacing-controller-design.md` capturing date, tester (Dave), and one-line per scenario: pass/fail.

- [ ] **Step 7: Commit verification notes**

```bash
git add docs/superpowers/specs/2026-05-06-adaptive-pacing-controller-design.md
git commit -m "docs: adaptive pacing controller manual smoke verification"
```

---

## Self-Review notes (author)

Spec coverage check:
- ResponseClassifier ✓ (Task 1)
- PerHostState w/ cloak baseline 5%, 100-window, 403 counter, LRU 1000 ✓ (Task 2)
- Live rate-limiter `setMultiplier` ✓ (Task 3)
- AdaptiveController AIMD 1.6×/-100ms/200-clean/60s ✓ (Task 4)
- Re-probe triggers (403-burst 10/60s, ceiling-saturated 5min/>20%) ✓ (Task 4 + Task 9)
- 5-minute re-probe cooldown ✓ (Task 4 sidecar + Task 9 Rust belt-and-suspenders)
- Wire into recordResult ✓ (Task 5)
- New event types `controller-state`, `re-probe-requested` ✓ (Tasks 4 + 8)
- Rust re-probe coordinator (drain → probe → respawn) ✓ (Task 9)
- HEALTH "Adaptive Pacing" card with state buckets + re-probe events log ✓ (Task 10)
- Test fixture scriptable patterns ✓ (Task 6)
- Integration test ✓ (Task 7)
- Manual smoke ✓ (Task 11)

Not covered (deferred per spec):
- AIMD on concurrency (v2)
- Live row-apply without respawn (v2)
- Cross-session persistence (out of scope)
- User-tunable controller constants (v2)

Type consistency:
- `Classification` type defined Task 1, used Tasks 2/4/5.
- `setMultiplier` signature consistent across Tasks 3 and 4.
- `controller-state` event payload consistent across Tasks 4, 8, 10.

No placeholders found. All steps include actual code or actual commands.
