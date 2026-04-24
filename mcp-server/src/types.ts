import type { ChildProcess } from "node:child_process";

export interface CrawlResult {
  url: string;
  status: number;
  title: string;
  h1: string;
  h2: string;
  metaDescription: string;
  canonical: string;
  wordCount: number;
  metaRobots: string;
  metaGooglebot: string;
  xRobotsTag: string;
  isIndexable: boolean;
  isNoindex: boolean;
  isNofollow: boolean;
  ogTitle: string;
  ogDescription: string;
  ogType: string;
  ogUrl: string;
  ogImage: string;
  ogImageWidth: number;
  ogImageHeight: number;
  ogImagePath?: string;
  datePublished: string;
  dateModified: string;
  datePublishedTime: string;
  dateModifiedTime: string;
  internalLinks: number;
  externalLinks: number;
  outlinks: string[];
  responseTime: number;
  contentType: string;
  resourceType: string;
  size: number;
  error?: string;
  responseHeaders?: Record<string, string>;
  redirectUrl?: string;
  serverHeader?: string;
  metaTags: Array<{ name: string; property: string; content: string }>;
}

export interface ServerState {
  crawlProcess: ChildProcess | null;
  browserProcess: ChildProcess | null;
  results: CrawlResult[];
  visitedUrls: Set<string>;
  status: "idle" | "crawling" | "stopped";
  startUrl: string;
  config: Record<string, any>;
  startedAt: string | null;
}

export interface CrawlSession {
  id: number;
  start_url: string;
  started_at: string;
  completed_at: string | null;
  result_count: number;
}
