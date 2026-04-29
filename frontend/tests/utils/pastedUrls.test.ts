import { describe, it, expect } from "vitest";
import { extractPastedUrls } from "../../src/utils/pastedUrls";

describe("extractPastedUrls", () => {
  it("newline-separated list (the SEO-tool standard format)", () => {
    const text = "https://a.com/1\nhttps://a.com/2\nhttps://a.com/3";
    expect(extractPastedUrls(text)).toEqual([
      "https://a.com/1",
      "https://a.com/2",
      "https://a.com/3",
    ]);
  });

  it("Windows-style CRLF line endings", () => {
    const text = "https://a.com/1\r\nhttps://a.com/2\r\nhttps://a.com/3";
    expect(extractPastedUrls(text)).toEqual([
      "https://a.com/1",
      "https://a.com/2",
      "https://a.com/3",
    ]);
  });

  it("comma-separated", () => {
    expect(extractPastedUrls("https://a, https://b, https://c")).toEqual([
      "https://a",
      "https://b",
      "https://c",
    ]);
  });

  it("mixed separators (newlines, commas, tabs)", () => {
    const text = "https://a.com\thttps://b.com,https://c.com\nhttps://d.com";
    expect(extractPastedUrls(text)).toEqual([
      "https://a.com",
      "https://b.com",
      "https://c.com",
      "https://d.com",
    ]);
  });

  it("filters out non-URL noise (header rows, blank lines, junk tokens)", () => {
    const text = "URL\nhttps://a.com\n\nfoo bar\nhttps://b.com\n";
    expect(extractPastedUrls(text)).toEqual(["https://a.com", "https://b.com"]);
  });

  it("preserves http (not just https)", () => {
    const text = "http://a.com\nhttps://b.com";
    expect(extractPastedUrls(text)).toEqual(["http://a.com", "https://b.com"]);
  });

  it("rejects bare hostnames without protocol — caller treats those as 'single URL paste, native paste handles it'", () => {
    expect(extractPastedUrls("example.com\nfoo.org")).toEqual([]);
  });

  it("single URL → array of length 1 (caller decides not to switch modes)", () => {
    expect(extractPastedUrls("https://only.one")).toEqual(["https://only.one"]);
  });

  it("empty input → empty array", () => {
    expect(extractPastedUrls("")).toEqual([]);
    expect(extractPastedUrls("   \n\n  ")).toEqual([]);
  });

  it("preserves URL paths and query strings — splits only on whitespace/commas, never inside a URL", () => {
    const text = "https://a.com/path?q=1&r=2\nhttps://b.com/x#frag";
    expect(extractPastedUrls(text)).toEqual([
      "https://a.com/path?q=1&r=2",
      "https://b.com/x#frag",
    ]);
  });
});
