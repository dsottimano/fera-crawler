import { describe, it, expect } from "vitest";
import { buildResultsFilter, sortFieldToColumn } from "../../src/utils/gridFilter";

describe("buildResultsFilter", () => {
  const noQueue = { recrawlQueue: [] };

  it("Internal/External tabs leave the filter wide-open", () => {
    expect(buildResultsFilter({ ...noQueue, tab: "Internal" })).toEqual({});
    expect(buildResultsFilter({ ...noQueue, tab: "External" })).toEqual({});
    expect(buildResultsFilter({ ...noQueue, tab: "Response Codes" })).toEqual({});
  });

  it("HTML-only tabs apply the resourceType filter", () => {
    for (const tab of ["Page Titles", "Meta Description", "H1", "H2", "Content", "Canonicals", "Directives", "Structured Data"]) {
      expect(buildResultsFilter({ ...noQueue, tab }).resourceType).toBe("HTML");
    }
  });

  it("JavaScript/CSS tabs apply matching resourceType filters", () => {
    expect(buildResultsFilter({ ...noQueue, tab: "JavaScript" }).resourceType).toBe("JavaScript");
    expect(buildResultsFilter({ ...noQueue, tab: "CSS" }).resourceType).toBe("CSS");
  });

  it("Images tab requires HTML rows that declared an og:image", () => {
    const f = buildResultsFilter({ ...noQueue, tab: "Images" });
    expect(f.resourceType).toBe("HTML");
    expect(f.hasOgImage).toBe(true);
  });

  it("Issues tab translates to issuesOnly=true (not hand-rolled OR clauses)", () => {
    const f = buildResultsFilter({ ...noQueue, tab: "Issues" });
    expect(f.issuesOnly).toBe(true);
  });

  it("Recrawl Queue tab sources urlIn from the live recrawl queue", () => {
    const queue = ["https://a", "https://b", "https://c"];
    const f = buildResultsFilter({ tab: "Recrawl Queue", recrawlQueue: queue });
    expect(f.urlIn).toEqual(queue);
    // Must be a copy — mutating the queue afterward must not change the filter snapshot.
    queue.push("https://d");
    expect(f.urlIn?.length).toBe(3);
  });

  it("Empty Recrawl Queue still emits urlIn=[] (Rust treats it as 'match nothing')", () => {
    const f = buildResultsFilter({ tab: "Recrawl Queue", recrawlQueue: [] });
    expect(f.urlIn).toEqual([]);
  });

  it("Response Codes tab + filterType '404' → status range [404, 405)", () => {
    const f = buildResultsFilter({ ...noQueue, tab: "Response Codes", filterType: "404" });
    expect(f.statusMin).toBe(404);
    expect(f.statusMax).toBe(405);
  });

  it("FilterBar 'All' value is treated as no filter", () => {
    const f = buildResultsFilter({ ...noQueue, tab: "Internal", filterType: "All" });
    expect(f).toEqual({});
  });

  it("FilterBar 'JavaScript' overrides whatever the tab said", () => {
    // Regression: tab=Internal (no resourceType) + FilterBar=JavaScript →
    // resourceType=JavaScript. Different combo: tab=H1 (resourceType=HTML)
    // + FilterBar=JavaScript → FilterBar wins.
    const f1 = buildResultsFilter({ ...noQueue, tab: "Internal", filterType: "JavaScript" });
    expect(f1.resourceType).toBe("JavaScript");
    const f2 = buildResultsFilter({ ...noQueue, tab: "H1", filterType: "JavaScript" });
    expect(f2.resourceType).toBe("JavaScript");
  });

  it("FilterBar 'Images' maps to resourceType='Image' (singular — for the Image resource type, not the Images tab)", () => {
    const f = buildResultsFilter({ ...noQueue, tab: "Internal", filterType: "Images" });
    expect(f.resourceType).toBe("Image");
  });

  it("Search query trims whitespace and drops empty input", () => {
    const f1 = buildResultsFilter({ ...noQueue, tab: "Internal", searchQuery: "  pricing  " });
    expect(f1.text).toBe("pricing");
    const f2 = buildResultsFilter({ ...noQueue, tab: "Internal", searchQuery: "   " });
    expect(f2.text).toBeUndefined();
  });

  it("Bogus filterType values silently fall through (not status filters)", () => {
    const f = buildResultsFilter({ ...noQueue, tab: "Response Codes", filterType: "garbage" });
    expect(f.statusMin).toBeUndefined();
    expect(f.statusMax).toBeUndefined();
  });
});

describe("sortFieldToColumn", () => {
  it("camelCase Tabulator fields map to snake_case Rust columns", () => {
    expect(sortFieldToColumn("responseTime")).toBe("response_time");
    expect(sortFieldToColumn("internalLinks")).toBe("internal_links");
    expect(sortFieldToColumn("wordCount")).toBe("word_count");
    expect(sortFieldToColumn("status")).toBe("status");
    expect(sortFieldToColumn("url")).toBe("url");
  });

  it("unknown fields return null (Rust falls back to id ASC)", () => {
    expect(sortFieldToColumn("evilColumn; DROP TABLE")).toBeNull();
    expect(sortFieldToColumn("ogImage")).toBeNull();  // not in whitelist
    expect(sortFieldToColumn(undefined)).toBeNull();
    expect(sortFieldToColumn(null)).toBeNull();
    expect(sortFieldToColumn("")).toBeNull();
  });
});
