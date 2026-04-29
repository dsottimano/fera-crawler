import { describe, it, expect } from "vitest";
import {
  clamp,
  commitNumericDraft,
  formatNumber,
  parseNumericDraft,
} from "../../src/utils/numericInput";

describe("clamp", () => {
  it("returns value unchanged when in range", () => {
    expect(clamp(5, { min: 0, max: 10 })).toBe(5);
  });
  it("clamps below min", () => {
    expect(clamp(-5, { min: 0, max: 10 })).toBe(0);
  });
  it("clamps above max", () => {
    expect(clamp(15, { min: 0, max: 10 })).toBe(10);
  });
  it("no min → only max applied", () => {
    expect(clamp(-100, { max: 10 })).toBe(-100);
  });
  it("no opts → identity", () => {
    expect(clamp(42, {})).toBe(42);
  });
});

describe("parseNumericDraft", () => {
  it("strips commas", () => {
    expect(parseNumericDraft("32,601")).toBe(32601);
  });
  it("strips non-numeric", () => {
    expect(parseNumericDraft("32a601")).toBe(32601);
  });
  it("empty → null (caller should hold off emitting)", () => {
    expect(parseNumericDraft("")).toBe(null);
  });
  it("lone minus → null", () => {
    expect(parseNumericDraft("-")).toBe(null);
  });
  it("negative number", () => {
    expect(parseNumericDraft("-500")).toBe(-500);
  });
  it("only commas → null", () => {
    expect(parseNumericDraft(",,,")).toBe(null);
  });
});

describe("commitNumericDraft (blur handler)", () => {
  it("garbage → revert to last good", () => {
    expect(commitNumericDraft("abc", 500, { min: 0 })).toBe(500);
  });
  it("empty → revert to last good", () => {
    expect(commitNumericDraft("", 500, {})).toBe(500);
  });
  it("clamps below min on commit", () => {
    expect(commitNumericDraft("-50", 500, { min: 0 })).toBe(0);
  });
  it("clamps above max on commit", () => {
    expect(commitNumericDraft("999", 500, { max: 50 })).toBe(50);
  });
  it("commits comma-formatted value", () => {
    expect(commitNumericDraft("32,601", 0, { min: 0 })).toBe(32601);
  });
});

describe("formatNumber", () => {
  it("inserts thousands separators", () => {
    expect(formatNumber(32601)).toBe("32,601");
  });
  it("small number no commas", () => {
    expect(formatNumber(42)).toBe("42");
  });
  it("non-finite → empty string", () => {
    expect(formatNumber(NaN)).toBe("");
    expect(formatNumber(Infinity)).toBe("");
  });
  it("zero", () => {
    expect(formatNumber(0)).toBe("0");
  });
});
