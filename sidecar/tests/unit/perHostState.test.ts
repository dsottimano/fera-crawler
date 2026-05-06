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
    expect(b!.medianBodyBytes).toBe(10500);
    expect(b!.medianInternalLinks).toBe(10.5);
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

  it("blockRate counts blocked-status:5xx as blocked", () => {
    const s = new PerHostStates();
    for (let i = 0; i < 95; i++) s.recordClassification("h.com", "ok");
    for (let i = 0; i < 5; i++) s.recordClassification("h.com", "blocked-status:5xx");
    expect(s.blockRate("h.com")).toBeCloseTo(0.05, 5);
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

  it("resetCleanStreak zeroes the counter", () => {
    const s = new PerHostStates();
    for (let i = 0; i < 10; i++) s.recordClassification("h.com", "ok");
    expect(s.cleanStreak("h.com")).toBe(10);
    s.resetCleanStreak("h.com");
    expect(s.cleanStreak("h.com")).toBe(0);
  });
});
