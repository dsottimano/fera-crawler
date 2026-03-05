export type ResourceType = "HTML" | "CSS" | "JavaScript" | "Image" | "Font" | "PDF" | "Other";

export interface CrawlResult {
  url: string;
  status: number;
  title: string;
  h1: string;
  metaDescription: string;
  canonical: string;
  internalLinks: number;
  externalLinks: number;
  responseTime: number;
  contentType: string;
  resourceType: ResourceType;
  size: number;
  error?: string;
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
  urls?: string[];  // for list mode
}
