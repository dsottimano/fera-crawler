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

export interface CrawlConfig {
  maxRequests: number;
  concurrency: number;
  userAgent: string;
  respectRobots: boolean;
  delay: number;
  customHeaders: Record<string, string>;
  mode: "spider" | "list";
  urls: string[];
  headless: boolean;
  downloadOgImage: boolean;
  scraperRules: ScraperRule[];
  scraperUrl: string;
  recrawlQueue: string[];
}

export const defaultConfig: CrawlConfig = {
  maxRequests: 0,
  concurrency: 5,
  userAgent: "",
  respectRobots: true,
  delay: 0,
  customHeaders: {},
  mode: "spider",
  urls: [],
  headless: true,
  downloadOgImage: false,
  scraperRules: [],
  scraperUrl: "",
  recrawlQueue: [],
};
