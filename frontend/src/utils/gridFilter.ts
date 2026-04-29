// Translation layer between the data-grid UI inputs (active tab, FilterBar
// status code, search bar, recrawl queue) and the typed ResultsFilter that
// the Rust query_results / count_results commands accept.
//
// Pure functions — extracted from CrawlGrid so the mapping is unit-tested
// independent of Tabulator. Every existing tab and FilterBar value MUST
// have an exact SQL equivalent here; without that, switching tabs during
// a crawl regresses to "shows all rows."

export interface ResultsFilter {
  statusMin?: number;
  statusMax?: number;
  hasRedirect?: boolean;
  indexability?: "indexable" | "noindex" | "nofollow";
  errorPrefix?: string;
  text?: string;
  emptyScraperRule?: string;
  resourceType?: string;
  issuesOnly?: boolean;
  urlIn?: string[];
  hasOgImage?: boolean;
}

export interface ResultsSort {
  column: string;
  direction: "asc" | "desc";
}

export interface BuildFilterArgs {
  tab: string;
  filterType?: string;
  searchQuery?: string;
  recrawlQueue: string[];
}

// Tabs whose only constraint is "rows that came from an HTML page". The
// SEO-data tabs (Page Titles, H1, …) all degrade meaningfully if we leak
// CSS / JS rows into them — sort by status / size etc. starts mixing
// resource types and the user can't tell what they're looking at.
const HTML_ONLY_TABS = new Set([
  "Page Titles",
  "Meta Description",
  "H1",
  "H2",
  "Content",
  "Canonicals",
  "Directives",
  "Structured Data",
]);

export function buildResultsFilter(args: BuildFilterArgs): ResultsFilter {
  const f: ResultsFilter = {};

  // Tab-driven constraints.
  switch (args.tab) {
    case "JavaScript":
      f.resourceType = "JavaScript";
      break;
    case "CSS":
      f.resourceType = "CSS";
      break;
    case "Images":
      // Existing behavior: Images tab = HTML rows that DECLARE an og:image.
      // (Image resource rows show up in the more general "External" tab.)
      f.resourceType = "HTML";
      f.hasOgImage = true;
      break;
    case "Issues":
      f.issuesOnly = true;
      break;
    case "Recrawl Queue":
      // Pending only — even after a partial drain, badge count and rows
      // stay in sync because we re-derive from the same queue array.
      f.urlIn = [...args.recrawlQueue];
      break;
    default:
      if (HTML_ONLY_TABS.has(args.tab)) f.resourceType = "HTML";
  }

  // FilterBar's secondary slicer.
  if (args.filterType && args.filterType !== "All") {
    if (args.tab === "Response Codes") {
      const code = parseInt(args.filterType, 10);
      if (!Number.isNaN(code)) {
        f.statusMin = code;
        f.statusMax = code + 1;
      }
    } else {
      // FilterBar uses the same vocabulary as resourceType for non-Response
      // tabs ("HTML"/"JavaScript"/"CSS"/"Images"). Tab + FilterBar both set
      // resourceType — FilterBar wins because it's the more specific signal.
      f.resourceType = args.filterType === "Images" ? "Image" : args.filterType;
    }
  }

  if (args.searchQuery && args.searchQuery.trim()) {
    f.text = args.searchQuery.trim();
  }

  return f;
}

// Tabulator column names use the camelCase data-field; Rust whitelists
// snake_case columns. Anything not in this map is dropped on the Rust
// side and falls back to ORDER BY id ASC, so it's safe to leak unknowns.
const FIELD_TO_COLUMN: Record<string, string> = {
  url: "url",
  status: "status",
  title: "title",
  h1: "h1",
  responseTime: "response_time",
  size: "size",
  internalLinks: "internal_links",
  externalLinks: "external_links",
  wordCount: "word_count",
  contentType: "content_type",
  resourceType: "resource_type",
  id: "id",
};

export function sortFieldToColumn(field: string | undefined | null): string | null {
  if (!field) return null;
  return FIELD_TO_COLUMN[field] ?? null;
}
