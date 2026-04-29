/**
 * Stealth init script builder.
 *
 * Produces a self-contained JS string suitable for
 * `context.addInitScript(script)` which runs before any page JS in the main
 * world. Everything is baked in at build time from a seeded fingerprint so
 * the in-page script has no external dependencies.
 *
 * Every patch is individually gate-able via StealthPatchConfig so the user
 * can toggle any fingerprinting defense independently. Defaults are all-on.
 */

import { createHash } from "node:crypto";

export type StealthPlatform = "Windows" | "macOS" | "Linux";

export interface StealthPatchConfig {
  /**
   * Master toggle. When false, no init script is installed and no
   * fingerprint-derived HTTP headers are set. Intended for A/B testing
   * whether our stealth is helping or hurting against a specific site.
   */
  enabled: boolean;
  /** Hide navigator.webdriver */
  webdriver: boolean;
  /** Install plausible navigator.plugins + mimeTypes */
  plugins: boolean;
  /** Claim en-US in navigator.languages / language */
  languages: boolean;
  /** Set navigator.platform to match claimed OS */
  platform: boolean;
  /** Randomize navigator.hardwareConcurrency / deviceMemory */
  hardwareClaims: boolean;
  /** Fake navigator.permissions.query({name:'notifications'}) → 'prompt' */
  permissions: boolean;
  /** Set Notification.permission → 'default' */
  notification: boolean;
  /** Install window.chrome {runtime, app, loadTimes, csi} shim */
  chromeStub: boolean;
  /** Randomize screen.* dimensions */
  screenMetrics: boolean;
  /** Align window.outerWidth/outerHeight with innerWidth/innerHeight */
  outerDimensions: boolean;
  /** Fake WebGL UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL strings */
  webglVendor: boolean;
  /** Return non-empty mediaDevices.enumerateDevices */
  mediaDevices: boolean;
  /** Install Battery API stub */
  battery: boolean;
  /** Install navigator.userAgentData with Chrome UA-CH high-entropy values */
  userAgentData: boolean;
  /** Force Event.prototype.isTrusted getter to return true */
  eventIsTrusted: boolean;
  /** Delete $cdc_/$wdc_ ChromeDriver automation markers on document */
  automationMarkers: boolean;
  /**
   * Mask every patched function's Function.prototype.toString output as
   * `[native code]`. Disabling this makes every other patch trivially
   * detectable — only turn off for debugging your own scripts.
   */
  nativeToString: boolean;
  /**
   * Inject session-deterministic noise into canvas operations
   * (toDataURL / getImageData / toBlob) so canvas fingerprinting
   * returns a hash that doesn't match public headless databases.
   */
  canvasNoise: boolean;
  /**
   * Override window.matchMedia for color-scheme / color-gamut /
   * dynamic-range / forced-colors / prefers-contrast / reduced-motion
   * queries so reported capabilities match the claimed platform.
   */
  matchMedia: boolean;
}

export const DEFAULT_STEALTH_PATCHES: StealthPatchConfig = {
  enabled: true,
  webdriver: true,
  plugins: true,
  languages: true,
  platform: true,
  hardwareClaims: true,
  permissions: true,
  notification: true,
  chromeStub: true,
  screenMetrics: true,
  outerDimensions: true,
  webglVendor: true,
  mediaDevices: true,
  battery: true,
  userAgentData: true,
  eventIsTrusted: true,
  automationMarkers: true,
  nativeToString: true,
  canvasNoise: true,
  matchMedia: true,
};

export interface StealthOpts {
  seed?: string | number;
  platform?: StealthPlatform;
  /** Force a Chrome major version (e.g., from a parsed UA override). */
  chromeMajor?: number;
  /** Force the full Chrome version string (e.g., "145.0.7258.82"). */
  chromeFullVersion?: string;
  patches?: Partial<StealthPatchConfig>;
}

/**
 * Parse a User-Agent string to extract platform + Chrome version.
 * Returns null for non-Chrome UAs (Firefox, Safari, etc.) so callers can
 * decide to skip Chrome-specific patches and headers rather than spoof
 * incoherently.
 */
export function parseUserAgent(ua: string): {
  platform: StealthPlatform;
  chromeMajor: number;
  chromeFullVersion: string;
} | null {
  if (!ua) return null;
  const chromeMatch = ua.match(/Chrome\/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  if (!chromeMatch) return null;
  // Reject Firefox/Safari/Edge which also contain "Chrome" only in some cases.
  // Real Chrome/Chromium has no "Firefox/" or "Safari/" ahead of "Chrome/".
  // (Safari DOES contain "Safari/" after Chrome in Chrome UAs — ignore it.)
  if (/Firefox\//.test(ua)) return null;
  // Edg, Brave, Opera all ship Chrome; accept them.

  const [, majorS, , buildS, patchS] = chromeMatch;
  const chromeMajor = parseInt(majorS, 10);
  const chromeFullVersion = `${majorS}.0.${buildS}.${patchS}`;

  let platform: StealthPlatform;
  if (/Windows NT/i.test(ua)) {
    platform = "Windows";
  } else if (/Macintosh|Mac OS X/i.test(ua)) {
    platform = "macOS";
  } else if (/X11|Linux/i.test(ua)) {
    platform = "Linux";
  } else {
    // Unknown platform token (Android, iOS, etc.) — we don't handle these yet.
    return null;
  }

  return { platform, chromeMajor, chromeFullVersion };
}

export interface Fingerprint {
  platform: StealthPlatform;
  navigatorPlatform: string;
  uaPlatform: string;
  uaPlatformVersion: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  screenWidth: number;
  screenHeight: number;
  screenColorDepth: number;
  availWidth: number;
  availHeight: number;
  webglVendor: string;
  webglRenderer: string;
  languages: string[];
  chromeMajor: number;
  chromeFullVersion: string;
  canvasSeed: number;
  prefersDark: boolean;
  colorGamutP3: boolean;
  dynamicRangeHigh: boolean;
}

// ── RNG ────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toSeed(x: string | number | undefined): number {
  if (typeof x === "number" && Number.isFinite(x)) return x >>> 0;
  if (typeof x === "string" && x.length > 0) {
    return createHash("sha256").update(x).digest().readUInt32LE(0);
  }
  return (Math.random() * 0x1_0000_0000) >>> 0;
}

function pick<T>(rng: () => number, pool: readonly T[]): T {
  return pool[Math.floor(rng() * pool.length)];
}

// ── Value pools ────────────────────────────────────────────────────────

const WEBGL_PAIRS: ReadonlyArray<readonly [string, string]> = [
  [
    "Google Inc. (Intel)",
    "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  ],
  [
    "Google Inc. (NVIDIA)",
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  ],
  [
    "Google Inc. (AMD)",
    "ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)",
  ],
  ["Apple Inc.", "ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)"],
  [
    "Google Inc. (Intel Inc.)",
    "ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics OpenGL Engine, OpenGL 4.1)",
  ],
];

const RESOLUTIONS: ReadonlyArray<readonly [number, number]> = [
  [1920, 1080],
  [2560, 1440],
  [1440, 900],
  [1366, 768],
  [1536, 864],
  [1680, 1050],
];

// ── Fingerprint generation ─────────────────────────────────────────────

export function generateFingerprint(opts: StealthOpts = {}): Fingerprint {
  const rng = mulberry32(toSeed(opts.seed));
  const platform: StealthPlatform =
    opts.platform ?? pick(rng, ["Windows", "macOS", "Linux"] as const);

  const navigatorPlatform =
    platform === "Windows"
      ? "Win32"
      : platform === "macOS"
      ? "MacIntel"
      : "Linux x86_64";

  const uaPlatform =
    platform === "Windows" ? "Windows" : platform === "macOS" ? "macOS" : "Linux";

  const uaPlatformVersion =
    platform === "Windows"
      ? pick(rng, ["10.0.0", "15.0.0", "19.0.0"])
      : platform === "macOS"
      ? pick(rng, ["14.6.1", "15.1.0", "15.3.1"])
      : pick(rng, ["6.8.0", "6.11.0"]);

  const [webglVendor, webglRenderer] = pick(rng, WEBGL_PAIRS);
  const [screenWidth, screenHeight] = pick(rng, RESOLUTIONS);

  const chromeBottom = platform === "macOS" ? 25 : 40;
  const availHeight = screenHeight - chromeBottom;

  // Honor Chrome version overrides (e.g., from a parsed UA). We still consume
  // the rng values so downstream picks stay deterministic regardless of whether
  // the caller overrode these.
  const rngChromeMajor = pick(rng, [143, 144, 145] as const);
  const rngChromeBuild = Math.floor(rng() * 8000) + 1000;
  const rngChromePatch = Math.floor(rng() * 200);
  const chromeMajor = opts.chromeMajor ?? rngChromeMajor;
  const chromeFullVersion =
    opts.chromeFullVersion ?? `${chromeMajor}.0.${rngChromeBuild}.${rngChromePatch}`;

  // Users on macOS skew toward P3 + sometimes HDR displays.
  const colorGamutP3 = platform === "macOS" && rng() < 0.55;
  const dynamicRangeHigh = colorGamutP3 && rng() < 0.25;
  // Dark mode split — roughly one in three users keeps dark mode on.
  const prefersDark = rng() < 0.35;

  const canvasSeed = Math.floor(rng() * 0x1_0000_0000) >>> 0;

  return {
    platform,
    navigatorPlatform,
    uaPlatform,
    uaPlatformVersion,
    hardwareConcurrency: pick(rng, [4, 8, 12, 16] as const),
    deviceMemory: pick(rng, [4, 8, 16] as const),
    screenWidth,
    screenHeight,
    screenColorDepth: 24,
    availWidth: screenWidth,
    availHeight,
    webglVendor,
    webglRenderer,
    languages: ["en-US", "en"],
    chromeMajor,
    chromeFullVersion,
    canvasSeed,
    prefersDark,
    colorGamutP3,
    dynamicRangeHigh,
  };
}

/**
 * Build HTTP headers consistent with a fingerprint.
 *
 * Akamai / Cloudflare / DataDome cross-check the HTTP User-Agent against
 * the JS-exposed userAgentData. Any mismatch is a hard tell. This must
 * be called with the same fingerprint used by buildStealthInitScript so
 * the two layers agree.
 *
 * Returns headers intended for Playwright's `extraHTTPHeaders` option.
 * `sec-fetch-*` headers are intentionally omitted — the browser sets
 * them correctly based on navigation context and overriding them breaks
 * in subtle ways.
 */
export function buildHeaders(fp: Fingerprint): Record<string, string> {
  const ua = buildUserAgent(fp);
  const brands = [
    { brand: "Not=A?Brand", version: "24" },
    { brand: "Chromium", version: String(fp.chromeMajor) },
    { brand: "Google Chrome", version: String(fp.chromeMajor) },
  ];
  const secChUa = brands
    .map((b) => `"${b.brand}";v="${b.version}"`)
    .join(", ");
  const chPlatform = `"${fp.uaPlatform}"`;

  return {
    "User-Agent": ua,
    "Accept-Language": fp.languages[0] + "," + fp.languages.slice(1).join(",") + ";q=0.9",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Sec-CH-UA": secChUa,
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": chPlatform,
    "Upgrade-Insecure-Requests": "1",
  };
}

/** Build the User-Agent string for a fingerprint. Matches real Chrome format. */
export function buildUserAgent(fp: Fingerprint): string {
  const ua = fp.chromeFullVersion;
  if (fp.platform === "Windows") {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ua} Safari/537.36`;
  }
  if (fp.platform === "macOS") {
    // Real Chrome on macOS still ships the frozen 10_15_7 Mac OS X string.
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ua} Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ua} Safari/537.36`;
}

export function fingerprintDigest(fp: Fingerprint): string {
  const raw = [
    fp.platform,
    fp.hardwareConcurrency,
    fp.deviceMemory,
    `${fp.screenWidth}x${fp.screenHeight}`,
    fp.chromeFullVersion,
    fp.webglVendor,
    fp.canvasSeed,
    fp.prefersDark ? 1 : 0,
    fp.colorGamutP3 ? 1 : 0,
  ].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 10);
}

// ── Script builder ─────────────────────────────────────────────────────

export function resolvePatches(p?: Partial<StealthPatchConfig>): StealthPatchConfig {
  return { ...DEFAULT_STEALTH_PATCHES, ...(p ?? {}) };
}

export function buildStealthInitScript(opts: StealthOpts = {}): string {
  const fp = generateFingerprint(opts);
  const patches = resolvePatches(opts.patches);
  const FP = JSON.stringify(fp);
  const P = JSON.stringify(patches);

  return `(() => {
'use strict';
const FP = ${FP};
const P = ${P};

// ── Native-function masking ────────────────────────────────────────
// Must be installed first so subsequent patches' toString is fake.
const fakeSources = new WeakMap();
const origFnToString = Function.prototype.toString;
function markNative(fn, name) {
  try {
    Object.defineProperty(fn, 'name', { value: name, configurable: true });
  } catch (_) {}
  fakeSources.set(fn, 'function ' + name + '() { [native code] }');
  return fn;
}

if (P.nativeToString) {
  const patched = function toString() {
    const fake = fakeSources.get(this);
    if (fake !== undefined) return fake;
    return origFnToString.call(this);
  };
  markNative(patched, 'toString');
  try {
    Function.prototype.toString = patched;
  } catch (_) {}
}

function defineGetter(obj, prop, getter, getterName) {
  markNative(getter, getterName || ('get ' + prop));
  try {
    Object.defineProperty(obj, prop, {
      get: getter,
      configurable: true,
      enumerable: true,
    });
  } catch (_) {}
}

function defineValue(obj, prop, value) {
  try {
    Object.defineProperty(obj, prop, {
      value,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  } catch (_) {}
}

// ── navigator.webdriver ────────────────────────────────────────────
if (P.webdriver) {
  defineGetter(Navigator.prototype, 'webdriver', () => undefined, 'get webdriver');
}

// ── navigator.languages / language ─────────────────────────────────
if (P.languages) {
  defineGetter(Navigator.prototype, 'languages', () => FP.languages, 'get languages');
  defineGetter(Navigator.prototype, 'language', () => FP.languages[0], 'get language');
}

// ── navigator.platform ─────────────────────────────────────────────
if (P.platform) {
  defineGetter(Navigator.prototype, 'platform', () => FP.navigatorPlatform, 'get platform');
}

// ── navigator.hardwareConcurrency / deviceMemory ───────────────────
if (P.hardwareClaims) {
  defineGetter(Navigator.prototype, 'hardwareConcurrency', () => FP.hardwareConcurrency, 'get hardwareConcurrency');
  defineGetter(Navigator.prototype, 'deviceMemory', () => FP.deviceMemory, 'get deviceMemory');
}

// ── navigator.plugins + mimeTypes ──────────────────────────────────
if (P.plugins) {
  (function installPluginsMimeTypes() {
    function makePlugin(name, filename, description) {
      const plugin = Object.create(Plugin.prototype);
      defineValue(plugin, 'name', name);
      defineValue(plugin, 'filename', filename);
      defineValue(plugin, 'description', description);
      defineValue(plugin, 'length', 0);
      return plugin;
    }
    const plugins = [
      makePlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      makePlugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      makePlugin('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      makePlugin('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      makePlugin('WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format'),
    ];
    const pluginArray = Object.create(PluginArray.prototype);
    plugins.forEach((p, i) => { pluginArray[i] = p; });
    defineValue(pluginArray, 'length', plugins.length);
    pluginArray.item = markNative(function item(i) { return plugins[i] || null; }, 'item');
    pluginArray.namedItem = markNative(function namedItem(name) {
      return plugins.find((p) => p.name === name) || null;
    }, 'namedItem');
    pluginArray.refresh = markNative(function refresh() {}, 'refresh');
    defineGetter(Navigator.prototype, 'plugins', () => pluginArray, 'get plugins');
    const mimeTypeArray = Object.create(MimeTypeArray.prototype);
    defineValue(mimeTypeArray, 'length', 0);
    mimeTypeArray.item = markNative(function item() { return null; }, 'item');
    mimeTypeArray.namedItem = markNative(function namedItem() { return null; }, 'namedItem');
    defineGetter(Navigator.prototype, 'mimeTypes', () => mimeTypeArray, 'get mimeTypes');
  })();
}

// ── navigator.permissions.query → 'prompt' for notifications ───────
if (P.permissions) {
  (function patchPermissions() {
    if (!navigator.permissions || !navigator.permissions.query) return;
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    const patched = function query(desc) {
      if (desc && desc.name === 'notifications') {
        return Promise.resolve({ state: 'prompt', onchange: null });
      }
      return origQuery(desc);
    };
    markNative(patched, 'query');
    try {
      navigator.permissions.query = patched;
    } catch (_) {}
  })();
}

// ── Notification.permission ────────────────────────────────────────
if (P.notification && typeof Notification !== 'undefined') {
  try {
    defineGetter(Notification, 'permission', () => 'default', 'get permission');
  } catch (_) {}
}

// ── window.chrome stub ─────────────────────────────────────────────
if (P.chromeStub) {
  (function installChromeStub() {
    if (window.chrome && typeof window.chrome.runtime !== 'undefined') return;
    const startTime = Date.now();
    const chrome = {
      app: {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: markNative(function getDetails() { return null; }, 'getDetails'),
        getIsInstalled: markNative(function getIsInstalled() { return false; }, 'getIsInstalled'),
      },
      runtime: {
        OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
      },
      loadTimes: markNative(function loadTimes() {
        return {
          requestTime: startTime / 1000 - 1.0,
          startLoadTime: startTime / 1000 - 0.5,
          commitLoadTime: startTime / 1000 - 0.3,
          finishDocumentLoadTime: startTime / 1000 - 0.1,
          finishLoadTime: startTime / 1000,
          firstPaintTime: startTime / 1000 - 0.05,
          firstPaintAfterLoadTime: 0,
          navigationType: 'Other',
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
          npnNegotiatedProtocol: 'h2',
          wasAlternateProtocolAvailable: false,
          connectionInfo: 'h2',
        };
      }, 'loadTimes'),
      csi: markNative(function csi() {
        return {
          onloadT: startTime,
          pageT: Date.now() - startTime,
          startE: startTime,
          tran: 15,
        };
      }, 'csi'),
    };
    try {
      Object.defineProperty(window, 'chrome', { value: chrome, configurable: true, enumerable: true, writable: true });
    } catch (_) {}
  })();
}

// ── screen dimensions ──────────────────────────────────────────────
if (P.screenMetrics) {
  defineGetter(Screen.prototype, 'width', () => FP.screenWidth, 'get width');
  defineGetter(Screen.prototype, 'height', () => FP.screenHeight, 'get height');
  defineGetter(Screen.prototype, 'availWidth', () => FP.availWidth, 'get availWidth');
  defineGetter(Screen.prototype, 'availHeight', () => FP.availHeight, 'get availHeight');
  defineGetter(Screen.prototype, 'colorDepth', () => FP.screenColorDepth, 'get colorDepth');
  defineGetter(Screen.prototype, 'pixelDepth', () => FP.screenColorDepth, 'get pixelDepth');
}

// ── outerWidth / outerHeight align with innerWidth / innerHeight ──
if (P.outerDimensions) {
  defineGetter(window, 'outerWidth', function () { return window.innerWidth; }, 'get outerWidth');
  defineGetter(window, 'outerHeight', function () { return window.innerHeight + 74; }, 'get outerHeight');
}

// ── WebGL vendor / renderer ────────────────────────────────────────
if (P.webglVendor) {
  (function patchWebGL() {
    const protos = [
      window.WebGLRenderingContext && WebGLRenderingContext.prototype,
      window.WebGL2RenderingContext && WebGL2RenderingContext.prototype,
    ].filter(Boolean);
    for (const proto of protos) {
      const getParameter = proto.getParameter;
      if (!getParameter) continue;
      const patched = function getParameter(pname) {
        if (pname === 37445) return FP.webglVendor;
        if (pname === 37446) return FP.webglRenderer;
        return getParameter.call(this, pname);
      };
      markNative(patched, 'getParameter');
      try { proto.getParameter = patched; } catch (_) {}
    }
  })();
}

// ── mediaDevices.enumerateDevices ──────────────────────────────────
if (P.mediaDevices && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
  const patched = async function enumerateDevices() {
    return [
      { deviceId: 'default',         groupId: 'grp1', kind: 'audioinput',  label: '' },
      { deviceId: 'communications',  groupId: 'grp1', kind: 'audioinput',  label: '' },
      { deviceId: 'default',         groupId: 'grp1', kind: 'audiooutput', label: '' },
    ];
  };
  markNative(patched, 'enumerateDevices');
  try { navigator.mediaDevices.enumerateDevices = patched; } catch (_) {}
}

// ── Battery API stub ───────────────────────────────────────────────
if (P.battery) {
  (function patchBattery() {
    const battery = {
      charging: true,
      chargingTime: 0,
      dischargingTime: Infinity,
      level: 1.0,
      addEventListener: markNative(function addEventListener() {}, 'addEventListener'),
      removeEventListener: markNative(function removeEventListener() {}, 'removeEventListener'),
      dispatchEvent: markNative(function dispatchEvent() { return true; }, 'dispatchEvent'),
    };
    const getBattery = markNative(async function getBattery() { return battery; }, 'getBattery');
    try {
      if (!('getBattery' in Navigator.prototype)) {
        Object.defineProperty(Navigator.prototype, 'getBattery', { value: getBattery, configurable: true });
      } else {
        navigator.getBattery = getBattery;
      }
    } catch (_) {}
  })();
}

// ── userAgentData ──────────────────────────────────────────────────
if (P.userAgentData) {
  (function patchUA_CH() {
    const brands = [
      { brand: 'Not=A?Brand', version: '24' },
      { brand: 'Chromium', version: String(FP.chromeMajor) },
      { brand: 'Google Chrome', version: String(FP.chromeMajor) },
    ];
    const fullVersionList = [
      { brand: 'Not=A?Brand', version: '24.0.0.0' },
      { brand: 'Chromium', version: FP.chromeFullVersion },
      { brand: 'Google Chrome', version: FP.chromeFullVersion },
    ];
    const uaData = {
      brands,
      mobile: false,
      platform: FP.uaPlatform,
      getHighEntropyValues: markNative(async function getHighEntropyValues(hints) {
        const base = {
          architecture: 'x86',
          bitness: '64',
          brands,
          fullVersionList,
          mobile: false,
          model: '',
          platform: FP.uaPlatform,
          platformVersion: FP.uaPlatformVersion,
          uaFullVersion: FP.chromeFullVersion,
          wow64: false,
        };
        if (!hints) return base;
        const result = { brands, mobile: false, platform: FP.uaPlatform };
        for (const h of hints) if (h in base) result[h] = base[h];
        return result;
      }, 'getHighEntropyValues'),
      toJSON: markNative(function toJSON() {
        return { brands, mobile: false, platform: FP.uaPlatform };
      }, 'toJSON'),
    };
    try {
      Object.defineProperty(Navigator.prototype, 'userAgentData', {
        get: markNative(function () { return uaData; }, 'get userAgentData'),
        configurable: true,
      });
    } catch (_) {}
  })();
}

// ── Event.isTrusted always true ────────────────────────────────────
if (P.eventIsTrusted) {
  try {
    const proto = Event.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'isTrusted');
    if (desc) {
      const origGet = desc.get;
      const patched = markNative(function () {
        if (origGet) {
          try {
            const real = origGet.call(this);
            if (real === true) return true;
          } catch (_) {}
        }
        return true;
      }, 'get isTrusted');
      Object.defineProperty(proto, 'isTrusted', { get: patched, configurable: true });
    }
  } catch (_) {}
}

// ── Automation markers ($cdc_*, $wdc_*) ────────────────────────────
if (P.automationMarkers) {
  try {
    for (const key of Object.keys(document)) {
      if (/^\\\$(cdc|wdc)_/.test(key)) {
        try { delete document[key]; } catch (_) {}
      }
    }
  } catch (_) {}
}

// ── Canvas fingerprint noise ───────────────────────────────────────
if (P.canvasNoise) {
  (function patchCanvas() {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    const ctxProto = CanvasRenderingContext2D.prototype;
    const origGetImageData = ctxProto.getImageData;

    function noiseRng(w, h) {
      // Stable-per-session: canvas dimensions xor the fingerprint seed.
      let s = (FP.canvasSeed ^ (w * 73856093) ^ (h * 19349663)) >>> 0;
      return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return (((t ^ (t >>> 14)) >>> 0) % 5) - 2; // -2 .. +2
      };
    }

    function applyNoise(imageData) {
      const rng = noiseRng(imageData.width, imageData.height);
      const d = imageData.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i]     = Math.max(0, Math.min(255, d[i]     + rng()));
        d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + rng()));
        d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + rng()));
      }
    }

    ctxProto.getImageData = markNative(function getImageData(sx, sy, sw, sh, settings) {
      const data = settings === undefined
        ? origGetImageData.call(this, sx, sy, sw, sh)
        : origGetImageData.call(this, sx, sy, sw, sh, settings);
      try { applyNoise(data); } catch (_) {}
      return data;
    }, 'getImageData');

    HTMLCanvasElement.prototype.toDataURL = markNative(function toDataURL() {
      try {
        if (this.width > 0 && this.height > 0) {
          const ctx = this.getContext('2d');
          if (ctx) {
            const d = origGetImageData.call(ctx, 0, 0, this.width, this.height);
            applyNoise(d);
            ctx.putImageData(d, 0, 0);
          }
        }
      } catch (_) {}
      return origToDataURL.apply(this, arguments);
    }, 'toDataURL');

    if (origToBlob) {
      HTMLCanvasElement.prototype.toBlob = markNative(function toBlob() {
        try {
          if (this.width > 0 && this.height > 0) {
            const ctx = this.getContext('2d');
            if (ctx) {
              const d = origGetImageData.call(ctx, 0, 0, this.width, this.height);
              applyNoise(d);
              ctx.putImageData(d, 0, 0);
            }
          }
        } catch (_) {}
        return origToBlob.apply(this, arguments);
      }, 'toBlob');
    }
  })();
}

// ── matchMedia color/motion/contrast answers ───────────────────────
if (P.matchMedia) {
  (function patchMatchMedia() {
    if (!window.matchMedia) return;
    const origMatchMedia = window.matchMedia.bind(window);
    const answers = {
      '(prefers-color-scheme: dark)': FP.prefersDark,
      '(prefers-color-scheme: light)': !FP.prefersDark,
      '(prefers-color-scheme: no-preference)': false,
      '(forced-colors: active)': false,
      '(forced-colors: none)': true,
      '(prefers-contrast: more)': false,
      '(prefers-contrast: less)': false,
      '(prefers-contrast: no-preference)': true,
      '(prefers-contrast: custom)': false,
      '(prefers-reduced-motion: reduce)': false,
      '(prefers-reduced-motion: no-preference)': true,
      '(prefers-reduced-transparency: reduce)': false,
      '(prefers-reduced-transparency: no-preference)': true,
      '(color-gamut: srgb)': true,
      '(color-gamut: p3)': FP.colorGamutP3,
      '(color-gamut: rec2020)': false,
      '(dynamic-range: high)': FP.dynamicRangeHigh,
      '(dynamic-range: standard)': !FP.dynamicRangeHigh,
      '(inverted-colors: inverted)': false,
      '(inverted-colors: none)': true,
    };

    const patched = function matchMedia(query) {
      const normalized = String(query).replace(/\\s+/g, ' ').trim().toLowerCase();
      const real = origMatchMedia(query);
      if (normalized in answers) {
        const forced = answers[normalized];
        return new Proxy(real, {
          get(target, prop) {
            if (prop === 'matches') return forced;
            if (prop === 'media') return query;
            const v = target[prop];
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
      }
      return real;
    };
    markNative(patched, 'matchMedia');
    try { window.matchMedia = patched; } catch (_) {}
  })();
}

})();`;
}
