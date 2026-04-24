import { describe, it, expect } from "vitest";
import { PerHostRateLimiter, parseRetryAfter } from "../../src/rate-limiter.js";

describe("PerHostRateLimiter", () => {
  it("three sequential acquires with 200ms delay take ~400ms+", async () => {
    const rl = new PerHostRateLimiter(200, 1);
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) {
      await rl.acquire("example.com");
      rl.release("example.com");
    }
    const elapsed = Date.now() - t0;
    // First acquire is immediate; 2nd and 3rd each wait ~200ms.
    expect(elapsed).toBeGreaterThanOrEqual(380);
    expect(elapsed).toBeLessThan(900); // generous ceiling for CI flakiness
  });

  it("concurrency slots block when full and release opens one", async () => {
    const rl = new PerHostRateLimiter(0, 2);
    await rl.acquire("x"); // slot 1
    await rl.acquire("x"); // slot 2 — now full

    let acquired = false;
    const pending = rl.acquire("x").then(() => { acquired = true; });

    // Give microtask queue a chance
    await new Promise((r) => setTimeout(r, 20));
    expect(acquired).toBe(false);

    rl.release("x");
    await pending;
    expect(acquired).toBe(true);
  });

  it("different hosts don't block each other", async () => {
    const rl = new PerHostRateLimiter(500, 1);
    await rl.acquire("a.com");
    const t0 = Date.now();
    await rl.acquire("b.com"); // different host — shouldn't wait
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(50);
    rl.release("a.com");
    rl.release("b.com");
  });

  it("snapshot reports current inFlight counts", async () => {
    const rl = new PerHostRateLimiter(0, 2);
    await rl.acquire("h");
    await rl.acquire("h");
    const snap = rl.snapshot();
    expect(snap.h.inFlight).toBe(2);
    rl.release("h");
    rl.release("h");
  });
});

describe("parseRetryAfter", () => {
  it("parses numeric seconds", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("1")).toBe(1_000);
  });

  it("parses HTTP-date", () => {
    const future = new Date(Date.now() + 5_000).toUTCString();
    const got = parseRetryAfter(future);
    expect(got).toBeGreaterThan(3_000);
    expect(got).toBeLessThanOrEqual(6_000);
  });

  it("returns 0 for past or invalid", () => {
    expect(parseRetryAfter("nonsense")).toBe(0);
    expect(parseRetryAfter(undefined)).toBe(0);
    expect(parseRetryAfter(null)).toBe(0);
    expect(parseRetryAfter("")).toBe(0);
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });
});
