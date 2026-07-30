import { describe, it, expect } from "vitest";
import { scopeBaseFor } from "../../src/crawler.js";

// Mirrors the `_inScope` predicate embedded in EXTRACT_SEO_SCRIPT. The real one
// runs inside the browser as a string, so it can't be imported; keeping an
// executable copy here pins the suffix-matching rules the crawl frontier and
// the internal/external link counts both depend on.
function inScope(host: string, base: string, pageHost: string): boolean {
  if (!base) return host === pageHost;
  return (
    host === base ||
    (host.length > base.length && host.slice(-(base.length + 1)) === "." + base)
  );
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
