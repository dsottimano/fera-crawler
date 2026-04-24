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
  stealth: {
    label: "Stealth",
    items: {
      webdriver: {
        type: "boolean",
        default: true,
        advanced: true,
        label: "Hide navigator.webdriver",
        help: "Prevents the most trivial automation check (navigator.webdriver === true).",
      },
      plugins: {
        type: "boolean",
        default: true,
        advanced: true,
        label: "Fake navigator.plugins / mimeTypes",
        help: "Real Chrome reports 3-5 PDF-related plugins; headless reports zero.",
      },
      languages: {
        type: "boolean",
        default: true,
        advanced: true,
        label: "Claim en-US in navigator.languages",
        help: "Ensures a non-empty languages array matching the Accept-Language header.",
      },
      platform: {
        type: "boolean",
        default: true,
        advanced: true,
        label: "Set navigator.platform from fingerprint",
        help: "Matches Win32 / MacIntel / Linux x86_64 to the randomized OS claim.",
      },
      hardwareClaims: {
        type: "boolean",
        default: true,
        advanced: true,
        label: "Randomize hardwareConcurrency + deviceMemory",
        help: "Per-session realistic values (4/8/12/16 cores; 4/8/16 GB).",
      },
      permissions: {
        type: "boolean",
        default: true,
        advanced: true,
        label: "Fake notifications permission as 'prompt'",
        help: "Headless returns 'denied' by default — a strong tell.",
      },
      notification: {
        type: "boolean",
        default: true,
        advanced: true,
        label: "Set Notification.permission to 'default'",
      },
      chromeStub: {
        type: "boolean",
        default: true,
        advanced: true,
        label: "Install window.chrome shim",
        help: "Provides chrome.runtime, chrome.app, loadTimes(), csi() — real Chrome has these, headless often doesn't.",
      },
      screenMetrics: {
        type: "boolean",
        default: true,
        advanced: true,
        label: "Randomize screen.* dimensions",
        help: "1920x1080 / 2560x1440 / 1440x900 etc. matched to availWidth/availHeight.",
      },
      outerDimensions: {
        type: "boolean",
        default: true,
        advanced: true,
        label: "Align window.outerWidth/outerHeight",
        help: "Headless reports 0 for outer dimensions. Real Chrome returns ~inner+browserChrome.",
      },
      webglVendor: {
        type: "boolean",
        default: true,
        advanced: true,
        label: "Fake WebGL vendor / renderer strings",
        help: "Intel / NVIDIA / AMD / Apple pairs — chosen deterministically per session.",
      },
      mediaDevices: {
        type: "boolean",
        default: true,
        advanced: true,
        label: "Return non-empty enumerateDevices",
        help: "Real browsers list at least a couple of audio devices.",
      },
      battery: {
        type: "boolean",
        default: true,
        advanced: true,
        label: "Install Battery API stub",
      },
      userAgentData: {
        type: "boolean",
        default: true,
        advanced: true,
        label: "Fake UA-CH (Chrome 145 brands, high-entropy values)",
        help: "navigator.userAgentData.brands / fullVersionList / platformVersion / architecture / bitness.",
      },
      eventIsTrusted: {
        type: "boolean",
        default: true,
        advanced: true,
        label: "Force Event.isTrusted = true",
        help: "Patches JS-dispatched events. Real user input already has isTrusted=true via CDP Input.",
      },
      automationMarkers: {
        type: "boolean",
        default: true,
        advanced: true,
        label: "Remove $cdc_ / $wdc_ markers from document",
        help: "ChromeDriver and Selenium leave these as an identification beacon.",
      },
      nativeToString: {
        type: "boolean",
        default: true,
        advanced: true,
        label: "Mask patched functions as [native code]",
        help: "DANGER — disabling makes every other patch trivially detectable. Only turn off for debugging your own script.",
      },
      canvasNoise: {
        type: "boolean",
        default: true,
        advanced: true,
        label: "Canvas fingerprint noise",
        help: "Session-deterministic ±2/channel RGB noise on toDataURL / getImageData / toBlob so canvas fingerprint hashes don't match public headless databases.",
      },
      matchMedia: {
        type: "boolean",
        default: true,
        advanced: true,
        label: "Match-media color / motion / contrast answers",
        help: "Spoofs prefers-color-scheme, color-gamut, dynamic-range, forced-colors, prefers-contrast, prefers-reduced-motion to match the claimed platform.",
      },
    },
  },
  advanced: {
    label: "Advanced",
    items: {
      perHostDelay: {
        type: "number",
        default: 500,
        min: 0,
        unit: "ms",
        advanced: true,
        label: "Per-host delay",
      },
      perHostConcurrency: {
        type: "number",
        default: 2,
        min: 1,
        max: 10,
        advanced: true,
        label: "Per-host concurrency",
      },
      debugLog: {
        type: "boolean",
        default: false,
        advanced: true,
        label: "Verbose sidecar logging",
      },
    },
  },
};
