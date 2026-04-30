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

  it("FilterBar resource-type tokens slice the Internal tab", () => {
    // CategoryTabs has no JavaScript/CSS tab — those are filter values on
    // the Internal tab. The "type:HTML" token from TAB_FILTERS maps to
    // resourceType in gridFilter.
    expect(buildResultsFilter({ ...noQueue, tab: "Internal", filterType: "type:JavaScript" }).resourceType).toBe("JavaScript");
    expect(buildResultsFilter({ ...noQueue, tab: "Internal", filterType: "type:CSS" }).resourceType).toBe("CSS");
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

  it("HEALTH-screen status-range tokens map to inclusive-exclusive ranges", () => {
    // Phase-5 click-throughs set filterType="2xx"/"3xx"/"4xx"/"5xx" and
    // expect the grid to land on Response Codes filtered by the matching
    // 100-code range.
    expect(buildResultsFilter({ ...noQueue, tab: "Response Codes", filterType: "2xx" })).toMatchObject({ statusMin: 200, statusMax: 300 });
    expect(buildResultsFilter({ ...noQueue, tab: "Response Codes", filterType: "3xx" })).toMatchObject({ statusMin: 300, statusMax: 400 });
    expect(buildResultsFilter({ ...noQueue, tab: "Response Codes", filterType: "4xx" })).toMatchObject({ statusMin: 400, statusMax: 500 });
    expect(buildResultsFilter({ ...noQueue, tab: "Response Codes", filterType: "5xx" })).toMatchObject({ statusMin: 500, statusMax: 600 });
  });

  it("Status-range tokens work regardless of which tab is active (drill-through can land anywhere)", () => {
    const f = buildResultsFilter({ ...noQueue, tab: "Internal", filterType: "4xx" });
    expect(f.statusMin).toBe(400);
    expect(f.statusMax).toBe(500);
  });

  // Tab-specific filter tokens (added when filters became per-tab — H2 →
  // "Missing H2" instead of the old "filter by MIME type" non-sense).
  describe("tab-specific tokens", () => {
    it("missing:<field> sets missingField for SEO-content tabs", () => {
      const cases = [
        ["Page Titles",      "missing:title",            "title"],
        ["Meta Description", "missing:meta_description", "meta_description"],
        ["H1",               "missing:h1",               "h1"],
        ["H2",               "missing:h2",               "h2"],
        ["Canonicals",       "canonical:missing",        undefined],
      ] as const;
      for (const [tab, token, expected] of cases) {
        const f = buildResultsFilter({ ...noQueue, tab, filterType: token });
        if (expected) expect(f.missingField).toBe(expected);
      }
    });

    it("title_len:lt:30 → titleLengthMax=30; title_len:gt:60 → titleLengthMin=61", () => {
      const f1 = buildResultsFilter({ ...noQueue, tab: "Page Titles", filterType: "title_len:lt:30" });
      expect(f1.titleLengthMax).toBe(30);
      expect(f1.titleLengthMin).toBeUndefined();
      const f2 = buildResultsFilter({ ...noQueue, tab: "Page Titles", filterType: "title_len:gt:60" });
      expect(f2.titleLengthMin).toBe(61);
      expect(f2.titleLengthMax).toBeUndefined();
    });

    it("word_count:lt:200 → wordCountMax=200", () => {
      const f = buildResultsFilter({ ...noQueue, tab: "Content", filterType: "word_count:lt:200" });
      expect(f.wordCountMax).toBe(200);
    });

    it("rt:gt:3000 → responseTimeMin=3001", () => {
      const f = buildResultsFilter({ ...noQueue, tab: "Response Times", filterType: "rt:gt:3000" });
      expect(f.responseTimeMin).toBe(3001);
    });

    it("duplicate:title → duplicateField='title'", () => {
      const f = buildResultsFilter({ ...noQueue, tab: "Page Titles", filterType: "duplicate:title" });
      expect(f.duplicateField).toBe("title");
    });

    it("canonical:self → canonicalState='self'", () => {
      const f = buildResultsFilter({ ...noQueue, tab: "Canonicals", filterType: "canonical:self" });
      expect(f.canonicalState).toBe("self");
    });

    it("idx:noindex → indexability='noindex'", () => {
      const f = buildResultsFilter({ ...noQueue, tab: "Directives", filterType: "idx:noindex" });
      expect(f.indexability).toBe("noindex");
    });

    it("url:long → urlPattern='long'; url:params → urlPattern='params'", () => {
      expect(buildResultsFilter({ ...noQueue, tab: "URL", filterType: "url:long" }).urlPattern).toBe("long");
      expect(buildResultsFilter({ ...noQueue, tab: "URL", filterType: "url:params" }).urlPattern).toBe("params");
    });

    it("Images tab default has og:image; missing_og_image inverts to missingOgImage and clears hasOgImage", () => {
      const def = buildResultsFilter({ ...noQueue, tab: "Images" });
      expect(def.hasOgImage).toBe(true);

      const inv = buildResultsFilter({ ...noQueue, tab: "Images", filterType: "missing_og_image" });
      expect(inv.missingOgImage).toBe(true);
      expect(inv.hasOgImage).toBeUndefined();
    });

    it("type:HTML on Internal sets resourceType (replaces old bare-string filter)", () => {
      const f = buildResultsFilter({ ...noQueue, tab: "Internal", filterType: "type:HTML" });
      expect(f.resourceType).toBe("HTML");
    });
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
