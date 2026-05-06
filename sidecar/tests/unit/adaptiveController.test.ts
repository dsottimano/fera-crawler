import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AdaptiveController, type ControllerEvent } from "../../src/adaptiveController.js";
import { PerHostStates } from "../../src/perHostState.js";
import { PerHostRateLimiter } from "../../src/rate-limiter.js";
import type { Classification } from "../../src/responseClassifier.js";

function setup() {
  const rl = new PerHostRateLimiter({ delayMinMs: 1000, maxConcurrency: 1 });
  const states = new PerHostStates();
  const events: ControllerEvent[] = [];
  const ctrl = new AdaptiveController({
    rateLimiter: rl,
    states,
    delayMinMs: 1000,
    onEvent: (e) => events.push(e),
  });
  return { rl, states, ctrl, events };
}

function feed(states: PerHostStates, ctrl: AdaptiveController, host: string, c: Classification, snap: { url: string; bodyBytes: number; internalLinks: number }) {
  states.recordClassification(host, c);
  ctrl.tick(host, c, snap);
}

describe("AdaptiveController", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("multiplies multiplier by 1.6 on block, clamps to ceiling", () => {
    const { rl, states, ctrl } = setup();
    feed(states, ctrl, "h.com", "blocked-status:429", { url: "https://h.com/", bodyBytes: 0, internalLinks: 0 });
    expect(rl.getMultiplier("h.com")).toBeCloseTo(1.6, 5);
    for (let i = 0; i < 50; i++) {
      feed(states, ctrl, "h.com", "blocked-status:429", { url: "https://h.com/", bodyBytes: 0, internalLinks: 0 });
    }
    expect(rl.getMultiplier("h.com")).toBe(15);
  });

  it("steps down -100ms after 200 clean responses + 60s since last block", () => {
    const { rl, states, ctrl } = setup();
    rl.setMultiplier("h.com", 2);
    feed(states, ctrl, "h.com", "blocked-status:429", { url: "https://h.com/", bodyBytes: 0, internalLinks: 0 });
    const after = rl.getMultiplier("h.com");
    vi.advanceTimersByTime(61_000);

    for (let i = 0; i < 199; i++) {
      feed(states, ctrl, "h.com", "ok", { url: "https://h.com/", bodyBytes: 50000, internalLinks: 80 });
    }
    expect(rl.getMultiplier("h.com")).toBe(after);
    feed(states, ctrl, "h.com", "ok", { url: "https://h.com/", bodyBytes: 50000, internalLinks: 80 });
    expect(rl.getMultiplier("h.com")).toBeCloseTo(after - 0.1, 5);
  });

  it("step-down does not fire if <60s since last block", () => {
    const { rl, states, ctrl } = setup();
    feed(states, ctrl, "h.com", "blocked-status:429", { url: "https://h.com/", bodyBytes: 0, internalLinks: 0 });
    const after = rl.getMultiplier("h.com");
    vi.advanceTimersByTime(30_000);
    for (let i = 0; i < 200; i++) {
      feed(states, ctrl, "h.com", "ok", { url: "https://h.com/", bodyBytes: 50000, internalLinks: 80 });
    }
    expect(rl.getMultiplier("h.com")).toBe(after);
  });

  it("emits re-probe-requested on 10 consecutive 403s within 60s", () => {
    const { states, ctrl, events } = setup();
    for (let i = 0; i < 10; i++) {
      feed(states, ctrl, "h.com", "blocked-status:403", { url: "https://h.com/p" + i, bodyBytes: 0, internalLinks: 0 });
    }
    const reprobe = events.find((e) => e.type === "re-probe-requested");
    expect(reprobe).toBeDefined();
    expect((reprobe as any).host).toBe("h.com");
    expect((reprobe as any).reason).toBe("403-burst");
  });

  it("does not re-emit re-probe within 5min cooldown", () => {
    const { states, ctrl, events } = setup();
    for (let i = 0; i < 10; i++) {
      feed(states, ctrl, "h.com", "blocked-status:403", { url: "https://h.com/p" + i, bodyBytes: 0, internalLinks: 0 });
    }
    expect(events.filter((e) => e.type === "re-probe-requested").length).toBe(1);
    vi.advanceTimersByTime(60_000);
    for (let i = 0; i < 10; i++) {
      feed(states, ctrl, "h.com", "blocked-status:403", { url: "https://h.com/p" + i, bodyBytes: 0, internalLinks: 0 });
    }
    expect(events.filter((e) => e.type === "re-probe-requested").length).toBe(1);
    vi.advanceTimersByTime(5 * 60_000 + 1000);
    for (let i = 0; i < 10; i++) {
      feed(states, ctrl, "h.com", "blocked-status:403", { url: "https://h.com/p" + i, bodyBytes: 0, internalLinks: 0 });
    }
    expect(events.filter((e) => e.type === "re-probe-requested").length).toBe(2);
  });

  it("emits re-probe on ceiling-saturated 5min + >20% block rate", () => {
    const { rl, states, ctrl, events } = setup();
    rl.setMultiplier("h.com", 15);
    for (let i = 0; i < 70; i++) feed(states, ctrl, "h.com", "ok", { url: "https://h.com/", bodyBytes: 50000, internalLinks: 80 });
    for (let i = 0; i < 30; i++) feed(states, ctrl, "h.com", "blocked-content", { url: "https://h.com/", bodyBytes: 1000, internalLinks: 0 });
    expect(events.filter((e) => e.type === "re-probe-requested").length).toBe(0);

    vi.advanceTimersByTime(5 * 60_000 + 1000);
    feed(states, ctrl, "h.com", "ok", { url: "https://h.com/", bodyBytes: 50000, internalLinks: 80 });
    const reprobe = events.find((e) => e.type === "re-probe-requested" && (e as any).reason === "ceiling-saturated");
    expect(reprobe).toBeDefined();
  });

  it("emits debounced controller-state events (<=1/s/host) on hold", () => {
    const { states, ctrl, events } = setup();
    feed(states, ctrl, "h.com", "ok", { url: "https://h.com/", bodyBytes: 50000, internalLinks: 80 });
    feed(states, ctrl, "h.com", "ok", { url: "https://h.com/", bodyBytes: 50000, internalLinks: 80 });
    feed(states, ctrl, "h.com", "ok", { url: "https://h.com/", bodyBytes: 50000, internalLinks: 80 });
    const stateEvts = events.filter((e) => e.type === "controller-state");
    expect(stateEvts.length).toBe(1);
    vi.advanceTimersByTime(1100);
    feed(states, ctrl, "h.com", "ok", { url: "https://h.com/", bodyBytes: 50000, internalLinks: 80 });
    expect(events.filter((e) => e.type === "controller-state").length).toBe(2);
  });

  it("does not trigger 403-burst re-probe when non-403 resets the consec counter mid-burst", () => {
    const { states, ctrl, events } = setup();
    for (let i = 0; i < 5; i++) {
      feed(states, ctrl, "h.com", "blocked-status:403", { url: "https://h.com/p" + i, bodyBytes: 0, internalLinks: 0 });
    }
    feed(states, ctrl, "h.com", "ok", { url: "https://h.com/ok", bodyBytes: 50000, internalLinks: 80 });
    for (let i = 0; i < 5; i++) {
      feed(states, ctrl, "h.com", "blocked-status:403", { url: "https://h.com/q" + i, bodyBytes: 0, internalLinks: 0 });
    }
    expect(events.filter((e) => e.type === "re-probe-requested").length).toBe(0);
  });

  it("does not trigger 403-burst when first 403 was >60s ago", () => {
    const { states, ctrl, events } = setup();
    feed(states, ctrl, "h.com", "blocked-status:403", { url: "https://h.com/first", bodyBytes: 0, internalLinks: 0 });
    vi.advanceTimersByTime(61_000);
    for (let i = 0; i < 9; i++) {
      feed(states, ctrl, "h.com", "blocked-status:403", { url: "https://h.com/p" + i, bodyBytes: 0, internalLinks: 0 });
    }
    expect(events.filter((e) => e.type === "re-probe-requested").length).toBe(0);
  });
});
