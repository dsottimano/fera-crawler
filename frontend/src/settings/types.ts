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
    perHostDelay: number;
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
  aiMcp: Record<string, never>;
  stealth: StealthPatches;
  advanced: {
    perHostDelay: number;
    perHostConcurrency: number;
    debugLog: boolean;
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
