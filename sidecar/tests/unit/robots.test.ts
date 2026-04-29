import { describe, it, expect } from "vitest";
import { __test } from "../../src/robots.js";

const { parseRobots, matchesPattern, isAllowedFor } = __test;

describe("robots.txt: pattern matching", () => {
  it("matches literal prefixes", () => {
    expect(matchesPattern("/admin/login", "/admin")).toBe(true);
    expect(matchesPattern("/public", "/admin")).toBe(false);
  });

  it("matches * wildcard", () => {
    expect(matchesPattern("/foo/bar.pdf", "/*.pdf")).toBe(true);
    expect(matchesPattern("/foo/bar.html", "/*.pdf")).toBe(false);
  });

  it("respects $ end-anchor", () => {
    expect(matchesPattern("/page.html", "/page.html$")).toBe(true);
    expect(matchesPattern("/page.html?q=1", "/page.html$")).toBe(false);
  });
});

describe("robots.txt: allow/disallow resolution", () => {
  it("allows by default when no rule matches", () => {
    expect(isAllowedFor("/foo", [])).toBe(true);
  });

  it("disallows matching path", () => {
    expect(isAllowedFor("/admin/x", [{ allow: false, pattern: "/admin" }])).toBe(false);
  });

  it("allow wins on longer match", () => {
    const rules = [
      { allow: false, pattern: "/admin" },
      { allow: true, pattern: "/admin/public" },
    ];
    expect(isAllowedFor("/admin/public/page", rules)).toBe(true);
    expect(isAllowedFor("/admin/private", rules)).toBe(false);
  });

  it("allow wins on tie (Google behavior)", () => {
    const rules = [
      { allow: false, pattern: "/same" },
      { allow: true, pattern: "/same" },
    ];
    expect(isAllowedFor("/same", rules)).toBe(true);
  });
});

describe("robots.txt: parser", () => {
  it("extracts rules and sitemaps for the matching user-agent group", () => {
    const txt = `
User-agent: *
Disallow: /private
Allow: /private/public

User-agent: Googlebot
Disallow: /google-only

Sitemap: https://example.com/sitemap.xml
    `;
    const parsed = parseRobots(txt, "Feracrawler");
    expect(parsed.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
    expect(isAllowedFor("/private/x", parsed.rules)).toBe(false);
    expect(isAllowedFor("/private/public/x", parsed.rules)).toBe(true);
    expect(isAllowedFor("/google-only", parsed.rules)).toBe(true); // not this UA
  });

  it("picks exact UA match over *", () => {
    const txt = `
User-agent: *
Disallow: /

User-agent: feracrawler
Allow: /
    `;
    const parsed = parseRobots(txt, "Feracrawler");
    expect(isAllowedFor("/any-path", parsed.rules)).toBe(true);
  });

  it("ignores comments and blank lines", () => {
    const txt = `
# Comment
User-agent: *   # trailing
Disallow: /x    # inline
    `;
    const parsed = parseRobots(txt, "bot");
    expect(isAllowedFor("/x", parsed.rules)).toBe(false);
  });
});
