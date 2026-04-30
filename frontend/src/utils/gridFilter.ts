// Translation layer between the data-grid UI inputs (active tab, FilterBar
// dropdown, search bar, recrawl queue) and the typed ResultsFilter that
// the Rust query_results / count_results commands accept.
//
// FilterBar dropdown options are *tab-specific* — see TAB_FILTERS below for
// the full table. Each option's `value` is a tagged token (e.g. "missing:h1",
// "title_len:lt:30") that this module parses into the right ResultsFilter
// fields. Pure functions; unit-tested independently of Tabulator.

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
  missingOgImage?: boolean;
  missingField?: "title" | "h1" | "h2" | "meta_description" | "canonical";
  titleLengthMin?: number;
  titleLengthMax?: number;
  metaDescLengthMin?: number;
  metaDescLengthMax?: number;
  h1LengthMin?: number;
  h1LengthMax?: number;
  wordCountMin?: number;
  wordCountMax?: number;
  responseTimeMin?: number;
  responseTimeMax?: number;
  duplicateField?: "title" | "meta_description" | "h1";
  canonicalState?: "missing" | "self" | "cross";
  urlPattern?: "long" | "params";
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

export interface FilterOption {
  label: string;
  value: string;
}

// Status-range filterType tokens emitted by the HEALTH screen drill-throughs.
const STATUS_RANGES: Record<string, [number, number]> = {
  "2xx": [200, 300],
  "3xx": [300, 400],
  "4xx": [400, 500],
  "5xx": [500, 600],
};

// Tabs whose only constraint is "rows that came from an HTML page". The
// SEO-data tabs (Page Titles, H1, …) all degrade meaningfully if we leak
// CSS / JS rows into them.
const HTML_ONLY_TABS = new Set([
  "Page Titles",
  "Meta Description",
  "H1",
  "H2",
  "Content",
  "Canonicals",
  "Directives",
  "Structured Data",
  "Response Times",
  "URL",
]);

// Per-tab dropdown options for FilterBar. Keyed by tab name; each option's
// `value` is parsed in applyTabFilter() below to produce the actual filter
// constraint. Adding a new option = add an entry here AND a parse case.
export const TAB_FILTERS: Record<string, FilterOption[]> = {
  Internal: [
    { label: "All", value: "all" },
    { label: "HTML", value: "type:HTML" },
    { label: "JavaScript", value: "type:JavaScript" },
    { label: "CSS", value: "type:CSS" },
    { label: "Images", value: "type:Image" },
    { label: "Fonts", value: "type:Font" },
    { label: "PDF", value: "type:PDF" },
    { label: "Other", value: "type:Other" },
  ],
  External: [
    { label: "All", value: "all" },
    { label: "2xx OK", value: "status:2xx" },
    { label: "3xx Redirect", value: "status:3xx" },
    { label: "4xx Client", value: "status:4xx" },
    { label: "5xx Server", value: "status:5xx" },
  ],
  Security: [
    { label: "All", value: "all" },
  ],
  // Response Codes filter options are computed dynamically in FilterBar
  // from the session's distinct status codes; this entry is a sentinel.
  "Response Codes": [{ label: "All", value: "all" }],
  URL: [
    { label: "All", value: "all" },
    { label: "Long URLs (>100)", value: "url:long" },
    { label: "Has parameters", value: "url:params" },
  ],
  "Page Titles": [
    { label: "All", value: "all" },
    { label: "Missing", value: "missing:title" },
    { label: "Short (<30)", value: "title_len:lt:30" },
    { label: "Long (>60)", value: "title_len:gt:60" },
    { label: "Duplicate", value: "duplicate:title" },
  ],
  "Meta Description": [
    { label: "All", value: "all" },
    { label: "Missing", value: "missing:meta_description" },
    { label: "Short (<70)", value: "meta_desc_len:lt:70" },
    { label: "Long (>160)", value: "meta_desc_len:gt:160" },
    { label: "Duplicate", value: "duplicate:meta_description" },
  ],
  H1: [
    { label: "All", value: "all" },
    { label: "Missing", value: "missing:h1" },
    { label: "Short (<10)", value: "h1_len:lt:10" },
    { label: "Long (>70)", value: "h1_len:gt:70" },
    { label: "Duplicate", value: "duplicate:h1" },
  ],
  H2: [
    { label: "All", value: "all" },
    { label: "Missing", value: "missing:h2" },
  ],
  Content: [
    { label: "All", value: "all" },
    { label: "Thin (<200 words)", value: "word_count:lt:200" },
    { label: "Low (<500 words)", value: "word_count:lt:500" },
    { label: "High (>2000 words)", value: "word_count:gt:2000" },
  ],
  Images: [
    { label: "All", value: "all" },
    { label: "Has og:image", value: "has_og_image" },
    { label: "Missing og:image", value: "missing_og_image" },
  ],
  Canonicals: [
    { label: "All", value: "all" },
    { label: "Missing", value: "canonical:missing" },
    { label: "Self-canonical", value: "canonical:self" },
    { label: "Cross-canonical", value: "canonical:cross" },
  ],
  Directives: [
    { label: "All", value: "all" },
    { label: "Indexable", value: "idx:indexable" },
    { label: "Noindex", value: "idx:noindex" },
    { label: "Nofollow", value: "idx:nofollow" },
  ],
  "Response Times": [
    { label: "All", value: "all" },
    { label: "Fast (<500ms)", value: "rt:lt:500" },
    { label: "Slow (>3000ms)", value: "rt:gt:3000" },
    { label: "Very slow (>10000ms)", value: "rt:gt:10000" },
  ],
  "Recrawl Queue": [{ label: "All", value: "all" }],
};

// Parses a tagged FilterBar token and applies it to the in-progress filter.
// Returns whether the token was recognized — caller falls back to legacy
// behavior (HEALTH drill-through tokens) when not.
function applyTabFilter(token: string, f: ResultsFilter, tab: string): boolean {
  if (token === "all") return true;
  // type:HTML / type:JavaScript / …
  if (token.startsWith("type:")) {
    f.resourceType = token.slice(5);
    return true;
  }
  // status:2xx | status:3xx | …
  if (token.startsWith("status:")) {
    const range = STATUS_RANGES[token.slice(7)];
    if (range) { f.statusMin = range[0]; f.statusMax = range[1]; }
    return true;
  }
  // missing:title | missing:h1 | missing:h2 | missing:meta_description | missing:canonical
  if (token.startsWith("missing:")) {
    const field = token.slice(8);
    if (["title", "h1", "h2", "meta_description", "canonical"].includes(field)) {
      f.missingField = field as ResultsFilter["missingField"];
    }
    return true;
  }
  // {field}_len:lt|gt:N — title/meta_desc/h1
  const lenMatch = token.match(/^(title|meta_desc|h1)_len:(lt|gt):(\d+)$/);
  if (lenMatch) {
    const [, field, op, nStr] = lenMatch;
    const n = parseInt(nStr, 10);
    if (field === "title") {
      if (op === "lt") f.titleLengthMax = n; else f.titleLengthMin = n + 1;
    } else if (field === "meta_desc") {
      if (op === "lt") f.metaDescLengthMax = n; else f.metaDescLengthMin = n + 1;
    } else if (field === "h1") {
      if (op === "lt") f.h1LengthMax = n; else f.h1LengthMin = n + 1;
    }
    return true;
  }
  // duplicate:title | duplicate:meta_description | duplicate:h1
  if (token.startsWith("duplicate:")) {
    const field = token.slice(10);
    if (["title", "meta_description", "h1"].includes(field)) {
      f.duplicateField = field as ResultsFilter["duplicateField"];
    }
    return true;
  }
  // word_count:lt:N | word_count:gt:N
  const wcMatch = token.match(/^word_count:(lt|gt):(\d+)$/);
  if (wcMatch) {
    const [, op, nStr] = wcMatch;
    const n = parseInt(nStr, 10);
    if (op === "lt") f.wordCountMax = n; else f.wordCountMin = n + 1;
    return true;
  }
  // rt:lt:N | rt:gt:N
  const rtMatch = token.match(/^rt:(lt|gt):(\d+)$/);
  if (rtMatch) {
    const [, op, nStr] = rtMatch;
    const n = parseInt(nStr, 10);
    if (op === "lt") f.responseTimeMax = n; else f.responseTimeMin = n + 1;
    return true;
  }
  // canonical:missing | canonical:self | canonical:cross
  if (token.startsWith("canonical:")) {
    const state = token.slice(10);
    if (["missing", "self", "cross"].includes(state)) {
      f.canonicalState = state as ResultsFilter["canonicalState"];
    }
    return true;
  }
  // idx:indexable | idx:noindex | idx:nofollow
  if (token.startsWith("idx:")) {
    const state = token.slice(4);
    if (["indexable", "noindex", "nofollow"].includes(state)) {
      f.indexability = state as ResultsFilter["indexability"];
    }
    return true;
  }
  // url:long | url:params
  if (token.startsWith("url:")) {
    const pat = token.slice(4);
    if (["long", "params"].includes(pat)) {
      f.urlPattern = pat as ResultsFilter["urlPattern"];
    }
    return true;
  }
  // has_og_image | missing_og_image
  if (token === "has_og_image") { f.hasOgImage = true; return true; }
  if (token === "missing_og_image") { f.missingOgImage = true; return true; }
  // Numeric status code (Response Codes tab dynamic options)
  if (tab === "Response Codes" && /^\d+$/.test(token)) {
    const code = parseInt(token, 10);
    f.statusMin = code;
    f.statusMax = code + 1;
    return true;
  }
  return false;
}

export function buildResultsFilter(args: BuildFilterArgs): ResultsFilter {
  const f: ResultsFilter = {};

  // Tab-driven base constraints.
  switch (args.tab) {
    case "Issues":
      f.issuesOnly = true;
      break;
    case "Recrawl Queue":
      f.urlIn = [...args.recrawlQueue];
      break;
    case "Images":
      // Default Images view = HTML rows that DECLARE an og:image. The
      // FilterBar can override (e.g. "Missing og:image" inverts).
      f.resourceType = "HTML";
      f.hasOgImage = true;
      break;
    default:
      if (HTML_ONLY_TABS.has(args.tab)) f.resourceType = "HTML";
  }

  // FilterBar's tab-specific token. Falls through to the legacy status-range
  // / resourceType fallbacks when the token isn't recognized — keeps HEALTH
  // drill-through compatibility ("Response Codes" + filterType="4xx").
  if (args.filterType && args.filterType !== "All") {
    const recognized = applyTabFilter(args.filterType, f, args.tab);
    if (!recognized) {
      const range = STATUS_RANGES[args.filterType];
      if (range) {
        f.statusMin = range[0];
        f.statusMax = range[1];
      } else if (args.tab === "Response Codes") {
        const code = parseInt(args.filterType, 10);
        if (!Number.isNaN(code)) {
          f.statusMin = code;
          f.statusMax = code + 1;
        }
      } else {
        // FilterBar legacy: bare "HTML"/"JavaScript"/etc. → resourceType.
        f.resourceType = args.filterType === "Images" ? "Image" : args.filterType;
      }
    }
    // Special case: when the user picks "Has og:image" / "Missing og:image"
    // on the Images tab, applyTabFilter sets the flag — but the tab default
    // already pinned hasOgImage=true. For "Missing og:image" we want the
    // inverse, so clear the default first.
    if (args.tab === "Images" && args.filterType === "missing_og_image") {
      f.hasOgImage = undefined;
    }
  }

  if (args.searchQuery && args.searchQuery.trim()) {
    f.text = args.searchQuery.trim();
  }

  return f;
}

// Tabulator column names use the camelCase data-field; Rust whitelists
// snake_case columns. Anything not in this map is dropped on the Rust side.
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
