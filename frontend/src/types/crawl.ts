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
}

// Transient per-crawl state. Persistent crawl knobs (concurrency, delay, mode,
// headless, …) live in the active profile (useSettings / SettingsPanel).
export interface CrawlConfig {
  customHeaders: Record<string, string>;
  urls: string[];
  scraperRules: ScraperRule[];
  scraperUrl: string;
  recrawlQueue: string[];
}

export const defaultConfig: CrawlConfig = {
  customHeaders: {},
  urls: [],
  scraperRules: [],
  scraperUrl: "",
  recrawlQueue: [],
};
