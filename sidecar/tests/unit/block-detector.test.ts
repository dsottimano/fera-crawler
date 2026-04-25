import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BlockDetector, hostOf } from "../../src/blockDetector.js";

const HOST = "example.com";
const url = (n: string | number) => `https://${HOST}/page-${n}`;

function tripGate(d: BlockDetector, host = HOST, n = 10) {
  let payload: ReturnType<typeof d.record> = null;
  for (let i = 0; i < n; i++) {
    const p = d.record({ url: url(i), status: 403 }, host);
    if (p) payload = p;
  }
  return payload;
}

describe("BlockDetector — classify", () => {
  it("classifies hard status blocks", () => {
    const d = new BlockDetector();
    expect(d.classify({ url: url(1), status: 403 }, HOST).reason).toBe("status_403");
    expect(d.classify({ url: url(2), status: 429 }, HOST).reason).toBe("status_429");
    expect(d.classify({ url: url(3), status: 503 }, HOST).reason).toBe("status_5xx");
    expect(d.classify({ url: url(4), status: 599 }, HOST).reason).toBe("status_5xx");
  });

  it("classifies soft block-phrase titles as blocked", () => {
    const d = new BlockDetector();
    const cases = [
      "Access Denied",
      "Just a moment...",
      "Attention Required! | Cloudflare",
      "Verify you are human",
      "Pardon Our Interruption",
    ];
    for (const t of cases) {
      const r = d.classify({ url: url(t), status: 200, title: t }, HOST);
      expect(r.blocked).toBe(true);
      expect(r.reason).toBe("soft_title_phrase");
    }
  });

  it("does NOT classify a benign 200 with normal title as blocked", () => {
    const d = new BlockDetector();
    const r = d.classify({ url: url("ok"), status: 200, title: "Welcome" }, HOST);
    expect(r.blocked).toBe(false);
  });

  it("classifies 200 with title repeated across ≥3 distinct URLs as soft block", () => {
    const d = new BlockDetector();
    const T = "Generic Page";
    // First 2 distinct URLs with same title — not yet a repeat
    d.record({ url: url("a"), status: 200, title: T }, HOST);
    d.record({ url: url("b"), status: 200, title: T }, HOST);
    expect(d.classify({ url: url("c"), status: 200, title: T }, HOST).blocked).toBe(false);
    // Add a 3rd: now the title-set has 3 URLs, classify returns soft block
    d.record({ url: url("c"), status: 200, title: T }, HOST);
    expect(d.classify({ url: url("d"), status: 200, title: T }, HOST).reason).toBe("soft_title_repeat");
  });
});

describe("BlockDetector — trip threshold", () => {
  it("does not trip below 10 of last 15", () => {
    const d = new BlockDetector();
    for (let i = 0; i < 9; i++) {
      const p = d.record({ url: url(i), status: 403 }, HOST);
      expect(p).toBeNull();
    }
    expect(d.isGated(HOST)).toBe(false);
  });

  it("trips on the 10th hard block within the window", () => {
    const d = new BlockDetector();
    const payload = tripGate(d);
    expect(d.isGated(HOST)).toBe(true);
    expect(payload).not.toBeNull();
    expect(payload?.host).toBe(HOST);
    expect(payload?.stats.blocked).toBeGreaterThanOrEqual(10);
    expect(payload?.attempt).toBe(1);
    expect(payload?.cooldownMs).toBeGreaterThan(0);
  });

  it("does not re-trip while already gated", () => {
    const d = new BlockDetector();
    tripGate(d);
    expect(d.isGated(HOST)).toBe(true);
    // Further blocks while gated should NOT produce additional payloads.
    const p = d.record({ url: url(99), status: 403 }, HOST);
    expect(p).toBeNull();
  });

  it("isolates per-host state — one host's trip doesn't gate another", () => {
    const d = new BlockDetector();
    tripGate(d, "a.com");
    expect(d.isGated("a.com")).toBe(true);
    expect(d.isGated("b.com")).toBe(false);
  });
});

describe("BlockDetector — auto-cooldown", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("auto-clears the gate after the cooldown delay and invokes onAutoClear", () => {
    const onAutoClear = vi.fn();
    const d = new BlockDetector({ onAutoClear, cooldownsMs: [60_000] });
    tripGate(d);
    expect(d.isGated(HOST)).toBe(true);

    vi.advanceTimersByTime(59_999);
    expect(d.isGated(HOST)).toBe(true);
    expect(onAutoClear).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2);
    expect(d.isGated(HOST)).toBe(false);
    expect(onAutoClear).toHaveBeenCalledWith(HOST);
    expect(onAutoClear).toHaveBeenCalledTimes(1);
  });

  it("backs off exponentially: 60s → 120s → 240s, then gives up", () => {
    const onAutoClear = vi.fn();
    const d = new BlockDetector({
      onAutoClear,
      cooldownsMs: [60_000, 120_000, 240_000],
    });

    // Trip 1 — 60s cooldown
    tripGate(d);
    expect(d.cooldownAttempts(HOST)).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(d.isGated(HOST)).toBe(false);
    expect(onAutoClear).toHaveBeenCalledTimes(1);

    // Trip 2 — 120s cooldown
    tripGate(d);
    expect(d.cooldownAttempts(HOST)).toBe(2);
    vi.advanceTimersByTime(60_000);
    expect(d.isGated(HOST)).toBe(true);  // still mid-cooldown
    vi.advanceTimersByTime(60_000);
    expect(d.isGated(HOST)).toBe(false);
    expect(onAutoClear).toHaveBeenCalledTimes(2);

    // Trip 3 — 240s cooldown
    tripGate(d);
    expect(d.cooldownAttempts(HOST)).toBe(3);
    vi.advanceTimersByTime(240_000);
    expect(d.isGated(HOST)).toBe(false);
    expect(onAutoClear).toHaveBeenCalledTimes(3);

    // Trip 4 — backoff ladder exhausted; gate stays.
    tripGate(d);
    expect(d.cooldownAttempts(HOST)).toBe(3);  // not incremented past length
    vi.advanceTimersByTime(10 * 60_000);  // way past anything
    expect(d.isGated(HOST)).toBe(true);
    expect(onAutoClear).toHaveBeenCalledTimes(3);  // not called again
  });

  it("user-initiated clearGate cancels pending cooldown and resets attempts", () => {
    const onAutoClear = vi.fn();
    const d = new BlockDetector({ onAutoClear, cooldownsMs: [60_000, 120_000] });
    tripGate(d);
    expect(d.isGated(HOST)).toBe(true);
    expect(d.cooldownAttempts(HOST)).toBe(1);

    // User clears mid-cooldown — timer should be cancelled.
    d.clearGate(HOST);
    expect(d.isGated(HOST)).toBe(false);
    expect(d.cooldownAttempts(HOST)).toBe(0);

    vi.advanceTimersByTime(120_000);
    expect(onAutoClear).not.toHaveBeenCalled();

    // Subsequent trip starts the backoff ladder from 0 again.
    tripGate(d);
    expect(d.cooldownAttempts(HOST)).toBe(1);
  });

  it("with cooldownsMs=[], no auto-clear is scheduled", () => {
    const onAutoClear = vi.fn();
    const d = new BlockDetector({ onAutoClear, cooldownsMs: [] });
    tripGate(d);
    expect(d.isGated(HOST)).toBe(true);
    vi.advanceTimersByTime(10 * 60_000);
    expect(d.isGated(HOST)).toBe(true);
    expect(onAutoClear).not.toHaveBeenCalled();
  });

  it("after auto-clear, parked URLs scenario: gate trips again immediately and uses the next cooldown step", () => {
    const onAutoClear = vi.fn();
    const d = new BlockDetector({ onAutoClear, cooldownsMs: [60_000, 120_000] });

    tripGate(d);
    vi.advanceTimersByTime(60_000);  // first cooldown fires
    expect(d.isGated(HOST)).toBe(false);

    // After auto-clear the window is empty. Tripping again requires another
    // 10 blocks. The NEXT cooldown should be the 2nd step (120s), not the 1st.
    tripGate(d);
    expect(d.cooldownAttempts(HOST)).toBe(2);
    vi.advanceTimersByTime(60_000);
    expect(d.isGated(HOST)).toBe(true);  // still gated — not the 60s step
    vi.advanceTimersByTime(60_000);
    expect(d.isGated(HOST)).toBe(false);  // now cleared at 120s
  });
});

describe("hostOf", () => {
  it("extracts hostname from a valid URL", () => {
    expect(hostOf("https://www.example.com/path?q=1")).toBe("www.example.com");
  });

  it("returns empty string for invalid input", () => {
    expect(hostOf("not a url")).toBe("");
    expect(hostOf("")).toBe("");
  });
});
