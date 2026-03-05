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
  error?: string;
}
