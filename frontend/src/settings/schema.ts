// Settings schema: single source of truth for every knob.
// Frontend always ships a fully-resolved config blob to the sidecar (see P0 §6),
// so the sidecar never needs to know these defaults.

import type { ScraperRule } from "../types/crawl";

export type SettingType =
  | "boolean"
  | "number"
  | "string"
  | "enum"
  | "rules"
  | "secret"
  | "url";

export interface SettingDef<T = unknown> {
  type: SettingType;
  default: T;
  label: string;
  help?: string;
  advanced?: boolean;
  hidden?: boolean;
  min?: number;
  max?: number;
  options?: readonly string[];
  unit?: string;
  validate?: (v: T) => string | null;
}

export interface SettingsSection {
  label: string;
  icon?: string;
  items: Record<string, SettingDef>;
}

export type SettingsSchema = Record<string, SettingsSection>;

export const SCHEMA_VERSION = 1;

export const SCHEMA: SettingsSchema = {
  crawling: {
    label: "Crawling",
    items: {
      mode: {
        type: "enum",
        default: "spider",
        options: ["spider", "list"] as const,
        label: "Crawl mode",
      },
      concurrency: {
        type: "number",
        default: 5,
        min: 1,
        max: 50,
        label: "Concurrency",
        help: "Parallel page loads",
      },
      maxRequests: {
        type: "number",
        default: 0,
        min: 0,
        label: "Max URLs",
        help: "0 = unlimited",
      },
      delay: {
        type: "number",
        default: 0,
        min: 0,
        unit: "ms",
        label: "Global delay",
        help: "Per-request floor; per-host rate limit still applies",
      },
      respectRobots: {
        type: "boolean",
        default: true,
        label: "Respect robots.txt",
      },
      discoverSitemap: {
        type: "boolean",
        default: true,
        label: "Discover sitemap.xml",
        help: "Fetch robots-declared + /sitemap.xml to seed URLs",
      },
    },
  },
  performance: {
    label: "Performance",
    items: {
      blockResources: {
        type: "boolean",
        default: true,
        label: "Block trackers, ads, fonts, media",
        help: "Drops 50–80% of page subrequests; ~3–5× faster",
      },
      closeOnExtract: {
        type: "boolean",
        default: true,
        label: "Close page after extraction",
        help: "Don't wait for full load unless Core Web Vitals is on",
      },
    },
  },
  extraction: {
    label: "Extraction",
    items: {
      captureVitals: {
        type: "boolean",
        default: false,
        label: "Capture Core Web Vitals",
        help: "LCP / CLS / FCP — slower, waits for load event",
      },
      downloadOgImage: {
        type: "boolean",
        default: false,
        label: "Download og:image",
      },
      scraperRules: {
        type: "rules",
        default: [] as ScraperRule[],
        label: "Custom extractors",
        help: "CSS selectors to extract arbitrary fields",
      },
    },
  },
  authentication: {
    label: "Authentication",
    items: {
      headless: {
        type: "boolean",
        default: true,
        label: "Headless mode",
        help: "Turn off to see the browser",
      },
    },
  },
  storage: {
    label: "Storage",
    items: {
      retentionDays: {
        type: "number",
        default: 30,
        min: 1,
        advanced: true,
        label: "Retention days",
      },
    },
  },
  aiMcp: {
    label: "AI & MCP",
    items: {},
  },
  advanced: {
    label: "Advanced",
    items: {
      stealthOverride: {
        type: "boolean",
        default: false,
        advanced: true,
        label: "Override stealth defaults",
        help: "Dangerous — may cause blocks",
      },
      stealthPerHostDelay: {
        type: "number",
        default: 500,
        min: 0,
        unit: "ms",
        advanced: true,
        label: "Per-host delay override",
      },
      stealthPerHostConcurrency: {
        type: "number",
        default: 2,
        min: 1,
        max: 10,
        advanced: true,
        label: "Per-host concurrency override",
      },
      debugLog: {
        type: "boolean",
        default: false,
        advanced: true,
        label: "Verbose sidecar logging",
      },
    },
  },
  _stealth: {
    label: "Stealth (internal)",
    items: {
      rotateUa: { type: "boolean", default: true, hidden: true, label: "" },
      uaPool: { type: "string", default: "default", hidden: true, label: "" },
      emitSecChUa: { type: "boolean", default: true, hidden: true, label: "" },
      applyInitPatches: { type: "boolean", default: true, hidden: true, label: "" },
      retry429: { type: "boolean", default: true, hidden: true, label: "" },
    },
  },
};
