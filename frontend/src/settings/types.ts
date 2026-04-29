import type { ScraperRule } from "../types/crawl";

export type { ScraperRule };

export interface StealthPatches {
  enabled: boolean;
  userAgent: string;
  webdriver: boolean;
  plugins: boolean;
  languages: boolean;
  platform: boolean;
  hardwareClaims: boolean;
  permissions: boolean;
  notification: boolean;
  chromeStub: boolean;
  screenMetrics: boolean;
  outerDimensions: boolean;
  webglVendor: boolean;
  mediaDevices: boolean;
  battery: boolean;
  userAgentData: boolean;
  eventIsTrusted: boolean;
  automationMarkers: boolean;
  nativeToString: boolean;
  canvasNoise: boolean;
  matchMedia: boolean;
}

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
    // perHostDelay = MIN ms between same-host requests. When perHostDelayMax
    // > perHostDelay, the sidecar samples a fresh uniform-random value from
    // [min, max] per request. Defeats interval-regularity bot detection.
    perHostDelay: number;
    perHostDelayMax: number;
    perHostConcurrency: number;
    sessionWarmup: boolean;
    // When a host gets gated by the block detector, automatically run the
    // 6-row probe matrix and apply the first winning row's settings if found.
    // Skipped if a manual probe is already running, or if this host has
    // already been auto-probed in this session (prevents loops).
    autoProbeOnBlock: boolean;
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
  stealth: StealthPatches;
  advanced: {
    debugLog: boolean;
  };
  // Per-crawl inputs (formerly the separate CrawlConfig blob). Stored in the
  // profile so there is a single source of truth for everything the user can
  // configure. Not surfaced in the schema-driven settings UI — edited via the
  // crawl inputs modal, list-mode textarea, scraper modal, etc.
  inputs: {
    urls: string[];
    customHeaders: Record<string, string>;
    scraperRules: ScraperRule[];
    recrawlQueue: string[];
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
}
