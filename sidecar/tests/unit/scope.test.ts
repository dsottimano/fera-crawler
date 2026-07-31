import { describe, it, expect } from "vitest";
import { scopeBaseFor, IN_SCOPE_SRC } from "../../src/crawler.js";

// Compiles the SHIPPED predicate source — the same string spliced into
// EXTRACT_SEO_SCRIPT — rather than a hand-copied duplicate, so loosening the
// real one (e.g. to a bare endsWith) fails here. It closes over `SCOPE` and
// `location`, which the browser supplies and we inject.
//
// `new Function` is safe here and only here: IN_SCOPE_SRC is a compile-time
// constant from our own module, never input, and this is test-only code.
function inScope(host: string, base: string, pageHost: string): boolean {
  const build = new Function(
    "SCOPE",
    "location",
    `return ${IN_SCOPE_SRC};`,
  ) as (scope: { base: string }, loc: { hostname: string }) => (h: string) => boolean;
  return build({ base }, { hostname: pageHost })(host);
}

describe("scopeBaseFor", () => {
  it("derives the same base whether the seed is apex or www", () => {
    expect(scopeBaseFor("https://babbel.com", "domain").base).toBe("babbel.com");
    expect(scopeBaseFor("https://www.babbel.com/en/magazine", "domain").base).toBe("babbel.com");
  });

  it("takes the registrable domain from the seed rather than guessing a suffix", () => {
    // Naive "last two labels" would yield co.uk and drag in the whole TLD.
    expect(scopeBaseFor("https://www.example.co.uk", "domain").base).toBe("example.co.uk");
  });

  it("keeps a non-www subdomain seed as its own base", () => {
    expect(scopeBaseFor("https://it.babbel.com", "domain").base).toBe("it.babbel.com");
  });

  it("returns an empty base for host scope and for unparseable seeds", () => {
    expect(scopeBaseFor("https://babbel.com", "host").base).toBe("");
    expect(scopeBaseFor("not a url", "domain").base).toBe("");
  });
});

describe("in-scope predicate", () => {
  const base = "babbel.com";

  it("admits the apex and every subdomain under it", () => {
    for (const h of ["babbel.com", "www.babbel.com", "it.babbel.com", "my.babbel.com"]) {
      expect(inScope(h, base, "www.babbel.com")).toBe(true);
    }
  });

  it("rejects a host that merely ends with the base's characters", () => {
    // The dot boundary is what stops "notbabbel.com" and "evilbabbel.com" —
    // a bare endsWith would admit both.
    expect(inScope("notbabbel.com", base, "www.babbel.com")).toBe(false);
    expect(inScope("babbel.com.attacker.net", base, "www.babbel.com")).toBe(false);
  });

  it("falls back to the page's own host when base is empty", () => {
    expect(inScope("www.babbel.com", "", "www.babbel.com")).toBe(true);
    expect(inScope("it.babbel.com", "", "www.babbel.com")).toBe(false);
  });
});
