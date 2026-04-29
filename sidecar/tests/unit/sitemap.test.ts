import { describe, it, expect } from "vitest";
import { __test } from "../../src/sitemap.js";

const { extractLocs, isSitemapIndex } = __test;

describe("sitemap: <loc> extraction", () => {
  it("extracts URLs from a urlset", () => {
    const xml = `<?xml version="1.0"?>
    <urlset>
      <url><loc>https://example.com/a</loc></url>
      <url><loc>https://example.com/b</loc></url>
    </urlset>`;
    expect(extractLocs(xml)).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("decodes XML entities", () => {
    const xml = `<urlset><url><loc>https://example.com/?a=1&amp;b=2</loc></url></urlset>`;
    expect(extractLocs(xml)).toEqual(["https://example.com/?a=1&b=2"]);
  });

  it("ignores whitespace in loc content", () => {
    const xml = `<urlset><url><loc>\n  https://example.com/x  \n</loc></url></urlset>`;
    expect(extractLocs(xml)).toEqual(["https://example.com/x"]);
  });
});

describe("sitemap: index detection", () => {
  it("flags sitemap indexes", () => {
    const xml = `<sitemapindex><sitemap><loc>https://example.com/s1.xml</loc></sitemap></sitemapindex>`;
    expect(isSitemapIndex(xml)).toBe(true);
  });

  it("does not flag plain urlsets", () => {
    expect(isSitemapIndex(`<urlset><url><loc>/</loc></url></urlset>`)).toBe(false);
  });
});
