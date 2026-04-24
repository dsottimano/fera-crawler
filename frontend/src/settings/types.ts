import type { ScraperRule } from "../types/crawl";

export type { ScraperRule };

export interface SettingsValues {
  crawling: {
    mode: "spider" | "list";
    concurrency: number;
    maxRequests: number;
    delay: number;
    respectRobots: boolean;
    discoverSitemap: boolean;
  };
  performance: {
    blockResources: boolean;
    closeOnExtract: boolean;
  };
  extraction: {
    captureVitals: boolean;
    downloadOgImage: boolean;
    scraperRules: ScraperRule[];
  };
  authentication: {
    headless: boolean;
  };
  storage: {
    retentionDays: number;
  };
  aiMcp: Record<string, never>;
  advanced: {
    stealthOverride: boolean;
    stealthPerHostDelay: number;
    stealthPerHostConcurrency: number;
    debugLog: boolean;
  };
  _stealth: {
    rotateUa: boolean;
    uaPool: string;
    emitSecChUa: boolean;
    applyInitPatches: boolean;
    retry429: boolean;
  };
}

export interface Profile {
  id: number;
  name: string;
  schemaVersion: number;
  values: SettingsValues;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  startUrl?: string;
}
