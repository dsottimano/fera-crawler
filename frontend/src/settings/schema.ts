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
  // String-type fields may expose named presets that populate the field on pick.
  // The free-text input stays editable so users can supply a custom value.
  presets?: readonly { label: string; value: string }[];
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
      perHostDelay: {
        type: "number",
        default: 500,
        min: 0,
        unit: "ms",
        label: "Per-host delay",
        help: "Minimum milliseconds between request starts to the same host. Real users don't hammer one domain; adaptive bot walls (Akamai, DataDome, PerimeterX) watch per-host RPS. 0 disables.",
      },
      perHostConcurrency: {
        type: "number",
        default: 2,
        min: 1,
        max: 10,
        label: "Per-host concurrency",
        help: "Maximum concurrent requests to the same host. Typical real-user concurrency is 2–4.",
      },
      sessionWarmup: {
        type: "boolean",
        default: false,
        label: "Warm up sessions before deep-linking",
        help: "Visit each origin's homepage for ~2.5s before deep-linking so Akamai/Cloudflare challenge cookies (_abck, ak_bmsc, __cf_bm) establish. Adds a few seconds per crawl, helps a lot against adaptive bot walls.",
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
        default: false,
        label: "Headless mode",
        help: "Headless is faster but easier for anti-bot systems to detect. Leave OFF against hardened targets (Akamai, Cloudflare, DataDome); flip ON for speed on permissive sites.",
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
      enabled: {
        type: "boolean",
        default: false,
        advanced: true,
        label: "Enable stealth (master)",
        help: "OFF (recommended) lets Patchright's binary-level patches do the work — no UA override, no custom headers, no init script. ON layers our custom fingerprint stack on top, which can actively hurt stealth against Akamai/DataDome. Flip ON only if you have a specific reason.",
      },
      userAgent: {
        type: "string",
        default: "",
        advanced: true,
        label: "User-Agent override",
        help: "Leave empty to use the fingerprint's randomized Chrome UA. Paste a string to force that exact UA. Chrome UAs (containing 'Chrome/X.Y.Z.W') automatically realign Sec-CH-UA, Sec-CH-UA-Platform, and navigator.platform to match. Firefox/Safari UAs pass through verbatim and Sec-CH-UA headers are suppressed (those browsers don't send them).",
        presets: [
          { label: "Googlebot Desktop", value: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/131.0.6778.264 Safari/537.36" },
          { label: "Googlebot Mobile", value: "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.264 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
          { label: "Googlebot Smartphone", value: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
          { label: "Bingbot", value: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36" },
          { label: "Bingbot Mobile", value: "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.92 Mobile Safari/537.36 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)" },
          { label: "DuckDuckBot", value: "Mozilla/5.0 (compatible; DuckDuckBot-Https/1.1; https://duckduckgo.com/duckduckbot)" },
          { label: "YandexBot", value: "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)" },
          { label: "Baiduspider", value: "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)" },
          { label: "Applebot", value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)" },
          { label: "Chrome Desktop (Win)", value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36" },
          { label: "Chrome Desktop (macOS)", value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36" },
          { label: "Chrome Mobile (Android)", value: "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36" },
          { label: "Safari iPhone", value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1" },
          { label: "Firefox Desktop", value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0" },
        ],
      },
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
