/**
 * Stealth init script builder.
 *
 * Produces a self-contained JS string suitable for
 * `context.addInitScript(script)` which runs before any page JS in the main
 * world. Everything is baked in at build time from a seeded fingerprint so
 * the in-page script has no external dependencies and no runtime Node I/O.
 *
 * Patch set is the superset of:
 *   - `2026-04-24-immediate-wins.md` § C (20 patches)
 *   - obscura's published fingerprinting list (Chrome 145 UA-CH, event.isTrusted,
 *     native-function masking, hidden internal properties)
 *
 * Keep this file the only place that knows about fingerprint values. The
 * crawler calls `buildStealthInitScript({ seed })` once per crawl and passes
 * the resulting string to Playwright.
 */

import { createHash } from "node:crypto";

export type StealthPlatform = "Windows" | "macOS" | "Linux";

export interface StealthOpts {
  /**
   * Deterministic fingerprint seed. Same seed + same opts ⇒ same script.
   * Pass the crawl's startUrl or a per-host hash so the fingerprint stays
   * consistent within a session but varies across runs.
   */
  seed?: string | number;
  /** Force a specific platform. Omit to randomize from the pool. */
  platform?: StealthPlatform;
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

  // Taskbar / menubar chrome estimate.
  const chromeBottom = platform === "macOS" ? 25 : 40;
  const availHeight = screenHeight - chromeBottom;

  const chromeMajor = pick(rng, [143, 144, 145] as const);
  const chromeBuild = Math.floor(rng() * 8000) + 1000;
  const chromePatch = Math.floor(rng() * 200);
  const chromeFullVersion = `${chromeMajor}.0.${chromeBuild}.${chromePatch}`;

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
  };
}

/**
 * Short digest of the fingerprint — useful for logging so we can see in
 * DEBUG which session got which fingerprint without dumping the whole thing.
 */
export function fingerprintDigest(fp: Fingerprint): string {
  const raw = [
    fp.platform,
    fp.hardwareConcurrency,
    fp.deviceMemory,
    `${fp.screenWidth}x${fp.screenHeight}`,
    fp.chromeFullVersion,
    fp.webglVendor,
  ].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 10);
}

// ── Script builder ─────────────────────────────────────────────────────

/**
 * Returns the in-page stealth script as a string. Pass to
 * `context.addInitScript(script)` BEFORE any other init scripts so our
 * native-toString masking wraps its own installation.
 */
export function buildStealthInitScript(opts: StealthOpts = {}): string {
  const fp = generateFingerprint(opts);
  const FP = JSON.stringify(fp);

  // NOTE: everything below runs in the page. Keep it self-contained.
  // Avoid template-literal interpolation inside the IIFE body except for FP.
  return `(() => {
'use strict';
const FP = ${FP};

// ── Native-function masking ────────────────────────────────────────
// Any function we install via defineProperty/replace should report
// \`function X() { [native code] }\` when stringified. We track the
// fake source per function with a WeakMap.
const fakeSources = new WeakMap();
const origFnToString = Function.prototype.toString;
function markNative(fn, name) {
  try {
    Object.defineProperty(fn, 'name', { value: name, configurable: true });
  } catch (_) {}
  fakeSources.set(fn, 'function ' + name + '() { [native code] }');
  return fn;
}

function installToStringHook() {
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
installToStringHook();

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
defineGetter(Navigator.prototype, 'webdriver', () => undefined, 'get webdriver');

// ── navigator.languages / language ─────────────────────────────────
defineGetter(Navigator.prototype, 'languages', () => FP.languages, 'get languages');
defineGetter(Navigator.prototype, 'language', () => FP.languages[0], 'get language');

// ── navigator.platform ─────────────────────────────────────────────
defineGetter(Navigator.prototype, 'platform', () => FP.navigatorPlatform, 'get platform');

// ── navigator.hardwareConcurrency / deviceMemory ───────────────────
defineGetter(Navigator.prototype, 'hardwareConcurrency', () => FP.hardwareConcurrency, 'get hardwareConcurrency');
defineGetter(Navigator.prototype, 'deviceMemory', () => FP.deviceMemory, 'get deviceMemory');

// ── navigator.plugins + mimeTypes ──────────────────────────────────
// Real Chrome ships 3 plugins. Create plausible PluginArray / MimeTypeArray.
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

// ── navigator.permissions.query → 'prompt' for notifications ───────
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

// ── Notification.permission ────────────────────────────────────────
if (typeof Notification !== 'undefined') {
  try {
    defineGetter(Notification, 'permission', () => 'default', 'get permission');
  } catch (_) {}
}

// ── window.chrome stub ─────────────────────────────────────────────
(function installChromeStub() {
  if (!window.chrome || typeof window.chrome.runtime === 'undefined') {
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
  }
})();

// ── screen dimensions ──────────────────────────────────────────────
defineGetter(Screen.prototype, 'width', () => FP.screenWidth, 'get width');
defineGetter(Screen.prototype, 'height', () => FP.screenHeight, 'get height');
defineGetter(Screen.prototype, 'availWidth', () => FP.availWidth, 'get availWidth');
defineGetter(Screen.prototype, 'availHeight', () => FP.availHeight, 'get availHeight');
defineGetter(Screen.prototype, 'colorDepth', () => FP.screenColorDepth, 'get colorDepth');
defineGetter(Screen.prototype, 'pixelDepth', () => FP.screenColorDepth, 'get pixelDepth');

// ── outerWidth / outerHeight align with innerWidth / innerHeight ──
// Headless Chrome reports 0 for outer dims. Real Chrome returns ~inner + chrome.
defineGetter(window, 'outerWidth', function () { return window.innerWidth; }, 'get outerWidth');
defineGetter(window, 'outerHeight', function () { return window.innerHeight + 74; }, 'get outerHeight');

// ── WebGL vendor / renderer ────────────────────────────────────────
(function patchWebGL() {
  const protos = [window.WebGLRenderingContext && WebGLRenderingContext.prototype,
                  window.WebGL2RenderingContext && WebGL2RenderingContext.prototype].filter(Boolean);
  for (const proto of protos) {
    const getParameter = proto.getParameter;
    if (!getParameter) continue;
    const patched = function getParameter(pname) {
      // UNMASKED_VENDOR_WEBGL = 0x9245, UNMASKED_RENDERER_WEBGL = 0x9246
      if (pname === 37445) return FP.webglVendor;
      if (pname === 37446) return FP.webglRenderer;
      return getParameter.call(this, pname);
    };
    markNative(patched, 'getParameter');
    try {
      proto.getParameter = patched;
    } catch (_) {}
  }
})();

// ── mediaDevices.enumerateDevices ──────────────────────────────────
if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
  const patched = async function enumerateDevices() {
    return [
      { deviceId: 'default',    groupId: 'grp1', kind: 'audioinput',  label: '' },
      { deviceId: 'communications', groupId: 'grp1', kind: 'audioinput', label: '' },
      { deviceId: 'default',    groupId: 'grp1', kind: 'audiooutput', label: '' },
    ];
  };
  markNative(patched, 'enumerateDevices');
  try {
    navigator.mediaDevices.enumerateDevices = patched;
  } catch (_) {}
}

// ── Battery API stub (always present, neutral values) ──────────────
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

// ── userAgentData (Chrome 145 high-entropy values) ─────────────────
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

// ── Event.isTrusted always true for synthetic events ───────────────
// Real user-input events (via CDP Input.dispatchMouseEvent) already have
// isTrusted=true. This patches JS-dispatched events for the minority of
// sites that synthesize a click and probe isTrusted.
(function patchIsTrusted() {
  try {
    const proto = Event.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'isTrusted');
    if (!desc) return;
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
  } catch (_) {}
})();

// ── Remove automation markers ──────────────────────────────────────
// ChromeDriver leaves $cdc_... and $wdc_... props on document. Selenium
// uses these for internal bookkeeping; they're a dead giveaway.
try {
  for (const key of Object.keys(document)) {
    if (/^\\\$(cdc|wdc)_/.test(key)) {
      try { delete document[key]; } catch (_) {}
    }
  }
} catch (_) {}

// ── Hide non-enumerable internal state from Object.keys(window) ────
// Our WeakMap doesn't live on window, so nothing to hide — but if future
// patches add window properties, they should all go through defineValue
// with enumerable:false.

})();`;
}
