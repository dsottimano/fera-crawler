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
  h1Count?: number;
  h2Count?: number;
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
  // Intermediate hop URLs for a redirected request (empty when not redirected).
  // Present in the query_all_results seo_json payload; typed here for reports.
  redirectChain?: string[];
  serverHeader?: string;

  // Rich SEO fields surfaced by query_all_results (persisted in seo_json).
  // Optional because older sessions / the paged grid may not carry them.
  hreflang?: Array<{ lang: string; href: string }>;
  structuredDataTypes?: string[];
  securityHeaders?: {
    hsts: boolean;
    csp: boolean;
    xFrameOptions: boolean;
    referrerPolicy: boolean;
    xContentTypeOptions: boolean;
    permissionsPolicy: boolean;
  };

  // All meta tags
  metaTags: MetaTag[];

  // Scraper
  scraper: Record<string, { value: string; appears: boolean }>;
}

// Legacy on-disk shape for `.fera` export files. Live config has moved into
// SettingsValues['inputs'] — this type only exists so useFileOps can read
// older .fera bundles. New saves serialize the same fields.
export interface CrawlConfig {
  customHeaders: Record<string, string>;
  urls: string[];
  scraperRules: ScraperRule[];
  recrawlQueue: string[];
}
