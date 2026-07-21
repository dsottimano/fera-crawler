import { describe, it, expect } from "vitest";
import { normalizeUrl } from "../../src/crawler.js";

describe("normalizeUrl — canonicalization (param-explosion defense)", () => {
  it("sorts query params into a stable order", () => {
    expect(normalizeUrl("https://e.com/?b=2&a=1")).toBe("https://e.com/?a=1&b=2");
    // Reordered variants of the same resource collapse to one form.
    expect(normalizeUrl("https://e.com/p?z=1&a=2&m=3")).toBe(
      normalizeUrl("https://e.com/p?a=2&m=3&z=1"),
    );
  });

  it("strips known tracking params but keeps meaningful ones", () => {
    expect(normalizeUrl("https://e.com/p?utm_source=x&id=5")).toBe("https://e.com/p?id=5");
    expect(normalizeUrl("https://e.com/p?fbclid=abc")).toBe("https://e.com/p");
    expect(normalizeUrl("https://e.com/p?gclid=abc&utm_medium=cpc&q=shoes")).toBe(
      "https://e.com/p?q=shoes",
    );
  });

  it("removes the fragment", () => {
    expect(normalizeUrl("https://e.com/p#section")).toBe("https://e.com/p");
  });

  it("lowercases host and drops default ports, preserving path case", () => {
    expect(normalizeUrl("https://E.COM:443/Path")).toBe("https://e.com/Path");
    expect(normalizeUrl("http://Example.com:80/a")).toBe("http://example.com/a");
  });

  it("preserves path case and distinct query values (no over-merging)", () => {
    expect(normalizeUrl("https://e.com/Page")).not.toBe(normalizeUrl("https://e.com/page"));
    expect(normalizeUrl("https://e.com/p?id=5")).not.toBe(normalizeUrl("https://e.com/p?id=6"));
  });

  it("makes campaign-tagged duplicates dedup-equal to the clean URL", () => {
    const clean = normalizeUrl("https://e.com/product?id=42");
    expect(normalizeUrl("https://e.com/product?id=42&utm_source=news&utm_campaign=spring")).toBe(clean);
    expect(normalizeUrl("https://e.com/product?utm_medium=email&id=42")).toBe(clean);
  });

  it("returns unparseable input unchanged", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
    expect(normalizeUrl("")).toBe("");
  });
});
