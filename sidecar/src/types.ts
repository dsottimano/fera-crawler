export type ResourceType = "HTML" | "CSS" | "JavaScript" | "Image" | "Font" | "PDF" | "Other";

export interface MetaTag {
  name: string;
  property: string;
  content: string;
}

export interface ScraperRule {
  name: string;
  selector: string;
}

export interface CrawlResult {
  url: string;
  status: number;
  title: string;
  h1: string;
  h2: string;
  metaDescription: string;
  canonical: string;
  wordCount: number;

  // Robots directives
  metaRobots: string;
  metaGooglebot: string;
  xRobotsTag: string;
  isIndexable: boolean;
  isNoindex: boolean;
  isNofollow: boolean;

  // Open Graph
  ogTitle: string;
  ogDescription: string;
  ogType: string;
  ogUrl: string;
  ogImage: string;
  ogImageWidth: number;
  ogImageHeight: number;
  ogImageWidthReal: number;
  ogImageHeightReal: number;
  ogImageRatio: number;
  ogImageFileSize: number;

  // Dates (dd-mm-yyyy format)
  datePublished: string;
  dateModified: string;
  datePublishedTime: string;
  dateModifiedTime: string;

  // Links
  internalLinks: number;
  externalLinks: number;
  outlinks: string[];

  // Response
  responseTime: number;
  contentType: string;
  resourceType: ResourceType;
  size: number;
  error?: string;
  responseHeaders?: Record<string, string>;
  redirectUrl?: string;
  serverHeader?: string;

  // All meta tags
  metaTags: MetaTag[];

  // Scraper
  scraper: Record<string, { value: string; appears: boolean }>;

  // Redirect chain (multi-hop capture; empty for non-redirected requests)
  redirectChain: string[];

  // hreflang alternates: [{ lang: "en-us", href: "..." }]
  hreflang: Array<{ lang: string; href: string }>;

  // Unique @type values from JSON-LD blocks (e.g. ["Article", "BreadcrumbList"])
  structuredDataTypes: string[];

  // Security-header presence booleans
  securityHeaders: {
    hsts: boolean;
    csp: boolean;
    xFrameOptions: boolean;
    referrerPolicy: boolean;
    xContentTypeOptions: boolean;
    permissionsPolicy: boolean;
  };

  // Discovery flags
  inSitemap: boolean;
  blockedByRobots: boolean;

  // JS runtime errors thrown on the page (Error.message strings)
  jsErrors: string[];
  // console.error messages
  consoleErrors: string[];
  // Subrequest URLs that failed to load (images, scripts, xhr, etc.)
  failedRequests: string[];

  // Performance metrics (ms). 0 when not captured or unavailable.
  // TTFB / DCL / load are always populated for HTML pages; LCP / CLS / FCP
  // require --capture-vitals which adds a bounded wait for load.
  perf: {
    ttfb: number;
    domContentLoaded: number;
    loadTime: number;
    fcp: number;
    lcp: number;
    cls: number;
  };
}

export interface CrawlConfig {
  startUrl: string;
  maxRequests: number;
  concurrency: number;
  userAgent?: string;
  respectRobots?: boolean;
  delay?: number;
  customHeaders?: Record<string, string>;
  mode: "spider" | "list";
  urls?: string[];
  browserProfile?: string;
  headless?: boolean;
  downloadOgImage?: boolean;
  scraperRules?: ScraperRule[];
  // Capture LCP/CLS/FCP — requires waiting for the 'load' event, slowing crawl.
  captureVitals?: boolean;
  // Partial patch config for stealth — unset patches take their defaults.
  // Omit stealthConfig entirely to get the full default patch set.
  stealthConfig?: Record<string, boolean>;
}
