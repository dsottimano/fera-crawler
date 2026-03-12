import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { writeLine } from "./pipeline.js";
import { classifyResource } from "./utils.js";
import type { CrawlConfig, CrawlResult } from "./types.js";

/**
 * Kills any Chrome/Chromium processes using the given user-data-dir.
 * Necessary because killing the Node sidecar doesn't always kill the Chrome child.
 */
/** Ensures a URL has a protocol prefix. */
function ensureProtocol(url: string): string {
  if (!/^https?:\/\//i.test(url)) return "https://" + url;
  return url;
}

function killChromeForProfile(profileDir: string): void {
  try {
    if (process.platform === "win32") {
      // Windows: use wmic to find and kill
      execSync(
        `wmic process where "CommandLine like '%--user-data-dir=${profileDir.replace(/\\/g, "\\\\")}%'" call terminate`,
        { stdio: "ignore", timeout: 5000 },
      );
    } else {
      // Linux/macOS: find PIDs matching our profile dir, kill them
      const result = execSync(
        `ps ax -o pid,args | grep -- "--user-data-dir=${profileDir}" | grep -v grep`,
        { encoding: "utf8", timeout: 5000 },
      );
      for (const line of result.trim().split("\n")) {
        const pid = parseInt(line.trim(), 10);
        if (pid && pid !== process.pid) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      }
    }
  } catch {
    // No matching processes — that's fine
  }

  // Clean up lock files after killing
  for (const lockName of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    const lockFile = path.join(profileDir, lockName);
    try { fs.unlinkSync(lockFile); } catch {}
  }

  // Brief pause to let the OS release file handles
  const start = Date.now();
  while (Date.now() - start < 500) { /* spin */ }
}

/**
 * Finds the bundled Chromium binary. Search order:
 * 1. FERA_CHROMIUM_PATH env var (explicit override — dev/testing)
 * 2. Bundled chromium next to the sidecar binary (production Tauri bundle)
 * 3. Playwright cache (dev fallback)
 */
export function findChromium(): string | undefined {
  // Explicit override (dev, testing, or user-configured)
  if (process.env.FERA_CHROMIUM_PATH) {
    if (fs.existsSync(process.env.FERA_CHROMIUM_PATH)) {
      return process.env.FERA_CHROMIUM_PATH;
    }
  }

  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const binaryName = isWindows
    ? "chrome.exe"
    : isMac
      ? "Chromium.app/Contents/MacOS/Chromium"
      : "chrome";

  // Bundled with Tauri — chromium/ directory next to or near the sidecar binary
  const resourcesDir = process.env.FERA_RESOURCES_DIR;
  const candidates = [
    ...(resourcesDir ? [path.join(resourcesDir, "chromium", binaryName)] : []),
    path.join(path.dirname(process.execPath), "chromium", binaryName),
    path.join(path.dirname(process.execPath), "..", "chromium", binaryName),
    // Linux AppImage / deb: resources are alongside the binary
    path.join(path.dirname(process.execPath), "..", "resources", "chromium", binaryName),
    // macOS .app bundle: Contents/Resources/
    path.join(path.dirname(process.execPath), "..", "Resources", "chromium", binaryName),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Dev fallback: check Playwright cache
  const home = os.homedir();
  let cacheDir: string;
  if (isWindows) {
    cacheDir = path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ms-playwright");
  } else if (isMac) {
    cacheDir = path.join(home, "Library", "Caches", "ms-playwright");
  } else {
    cacheDir = path.join(home, ".cache", "ms-playwright");
  }

  if (fs.existsSync(cacheDir)) {
    const entries = fs.readdirSync(cacheDir)
      .filter((e) => e.startsWith("chromium-"))
      .sort();
    if (entries.length > 0) {
      const latest = entries[entries.length - 1];
      const subdir = isWindows ? "chrome-win" : isMac ? "chrome-mac" : "chrome-linux";
      const cacheBinary = path.join(cacheDir, latest, subdir, binaryName);
      if (fs.existsSync(cacheBinary)) return cacheBinary;
    }
  }

  return undefined;
}

/**
 * Returns the persistent browser profile directory.
 * Passed via --browser-profile flag or defaults to OS app data dir.
 */
export function getBrowserProfileDir(profileArg?: string): string {
  if (profileArg) return profileArg;

  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "com.fera.crawler", "browser-profile");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "com.fera.crawler", "browser-profile");
  }
  return path.join(home, ".local", "share", "com.fera.crawler", "browser-profile");
}

/**
 * Chromium args that reduce automation fingerprinting.
 * Strips Playwright's default automation signals so sites
 * see a normal browser instead of a bot.
 */
const STEALTH_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  "--disable-features=AutomationControlled",
  "--disable-infobars",
  "--no-first-run",
  "--no-default-browser-check",
  "--password-store=basic",
];

async function crawlPage(page: Page, url: string): Promise<{ result: CrawlResult; links: string[] }> {
  const startTime = Date.now();
  let status = 0;
  let contentType = "";
  let size = 0;
  let error: string | undefined;
  let links: string[] = [];
  let responseHeaders: Record<string, string> = {};
  let redirectUrl: string | undefined;
  let serverHeader: string | undefined;

  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const responseTime = Date.now() - startTime;
    status = response?.status() ?? 0;

    // Capture all response headers
    if (response) {
      try {
        responseHeaders = await response.allHeaders();
      } catch {
        responseHeaders = response.headers();
      }
      contentType = responseHeaders["content-type"] ?? "";
      serverHeader = responseHeaders["server"] ?? undefined;

      // Detect redirects: if final URL differs from requested URL
      const finalUrl = response.url();
      if (finalUrl !== url) {
        redirectUrl = finalUrl;
      }
    }

    try {
      const body = await response?.body();
      size = body ? body.length : 0;
    } catch {}

    const data = await page.evaluate(() => {
      const title = document.querySelector("title")?.textContent?.trim() ?? "";
      const h1 = document.querySelector("h1")?.textContent?.trim() ?? "";
      const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() ?? "";
      const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? "";

      const anchors = Array.from(document.querySelectorAll("a[href]"));
      let internal = 0;
      let external = 0;
      const discoveredLinks: string[] = [];
      for (const a of anchors) {
        try {
          const href = new URL((a as HTMLAnchorElement).href, location.origin);
          if (href.hostname === location.hostname) {
            internal++;
            href.hash = "";
            discoveredLinks.push(href.href);
          } else {
            external++;
          }
        } catch {}
      }
      return { title, h1, metaDescription: metaDesc, canonical, internalLinks: internal, externalLinks: external, discoveredLinks };
    });

    links = data.discoveredLinks;

    return {
      result: {
        url,
        status,
        title: data.title,
        h1: data.h1,
        metaDescription: data.metaDescription,
        canonical: data.canonical,
        internalLinks: data.internalLinks,
        externalLinks: data.externalLinks,
        responseTime,
        contentType,
        resourceType: classifyResource(contentType),
        size,
        responseHeaders,
        redirectUrl,
        serverHeader,
      },
      links,
    };
  } catch (err: any) {
    return {
      result: {
        url,
        status: 0,
        title: "",
        h1: "",
        metaDescription: "",
        canonical: "",
        internalLinks: 0,
        externalLinks: 0,
        responseTime: Date.now() - startTime,
        contentType: "",
        resourceType: "Other",
        size: 0,
        error: err.message,
        responseHeaders: {},
      },
      links: [],
    };
  }
}

export async function runCrawler(config: CrawlConfig): Promise<void> {
  const executablePath = findChromium();
  const userDataDir = getBrowserProfileDir(config.browserProfile);

  // Ensure the profile directory exists
  fs.mkdirSync(userDataDir, { recursive: true });

  const headless = config.headless !== false;  // default true

  // Kill any Chrome processes still holding onto this profile directory
  killChromeForProfile(userDataDir);

  const launchOpts = {
    headless,
    executablePath,
    args: headless ? STEALTH_ARGS : [...STEALTH_ARGS, "--start-maximized"],
    ignoreDefaultArgs: ["--enable-automation"] as string[],
    ...(headless ? {} : { viewport: null as null }),
    ...(config.userAgent ? { userAgent: config.userAgent } : {}),
    ...(config.customHeaders ? { extraHTTPHeaders: config.customHeaders } : {}),
  };

  // Retry once if profile is still locked (process may still be shutting down)
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(userDataDir, launchOpts);
  } catch (err: any) {
    if (err.message?.includes("existing browser session") || err.message?.includes("Target page, context or browser has been closed")) {
      await new Promise((r) => setTimeout(r, 2000));
      killChromeForProfile(userDataDir);
      context = await chromium.launchPersistentContext(userDataDir, launchOpts);
    } else {
      throw err;
    }
  }

  // Patch navigator.webdriver to avoid bot detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const visited = new Set<string>();
  const queue: string[] = [];
  let processed = 0;

  if (config.mode === "list" && config.urls?.length) {
    queue.push(...config.urls.map(ensureProtocol));
  } else {
    queue.push(ensureProtocol(config.startUrl));
  }

  // In headed mode: single tab, sequential, with natural pacing
  const effectiveConcurrency = headless ? config.concurrency : 1;
  const effectiveDelay = headless ? (config.delay ?? 0) : Math.max(config.delay ?? 0, 1000);

  try {
    // In headed mode, reuse a single tab (don't close pages — that kills the context)
    let reusePage: Page | null = null;
    if (!headless) {
      const existingPages = context.pages();
      reusePage = existingPages.length > 0 ? existingPages[0] : await context.newPage();
      // Close any extra about:blank tabs, but keep at least one
      for (let i = 1; i < existingPages.length; i++) {
        await existingPages[i].close().catch(() => {});
      }
    }

    while (queue.length > 0 && processed < config.maxRequests) {
      const batch = queue.splice(0, effectiveConcurrency);
      const tasks = batch
        .filter((url) => {
          if (visited.has(url)) return false;
          visited.add(url);
          return true;
        })
        .slice(0, config.maxRequests - processed);

      if (tasks.length === 0) continue;

      if (reusePage) {
        // Headed: crawl sequentially in a single tab
        for (const url of tasks) {
          if (effectiveDelay > 0) {
            await new Promise((r) => setTimeout(r, effectiveDelay));
          }
          const { result, links } = await crawlPage(reusePage, url);
          writeLine(result);
          processed++;
          if (config.mode === "spider") {
            for (const link of links) {
              if (!visited.has(link) && queue.length + processed < config.maxRequests) {
                queue.push(link);
              }
            }
          }
        }
      } else {
        // Headless: parallel tabs as before
        const results = await Promise.all(
          tasks.map(async (url) => {
            const page = await context.newPage();
            try {
              if (effectiveDelay > 0) {
                await new Promise((r) => setTimeout(r, effectiveDelay));
              }
              return await crawlPage(page, url);
            } finally {
              await page.close();
            }
          }),
        );

        for (const { result, links } of results) {
          writeLine(result);
          processed++;
          if (config.mode === "spider") {
            for (const link of links) {
              if (!visited.has(link) && queue.length + processed < config.maxRequests) {
                queue.push(link);
              }
            }
          }
        }
      }
    }
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Opens a visible browser window for the user to sign in.
 * Uses the same persistent profile as the crawler so session data carries over.
 * Outputs a JSON status line when the browser is closed.
 */
export async function openBrowser(rawUrl: string, profileDir?: string): Promise<void> {
  const url = ensureProtocol(rawUrl);
  const executablePath = findChromium();
  const userDataDir = getBrowserProfileDir(profileDir);

  fs.mkdirSync(userDataDir, { recursive: true });
  killChromeForProfile(userDataDir);

  writeLine({ event: "browser-opened", url } as any);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath,
    args: [...STEALTH_ARGS, "--start-maximized"],
    ignoreDefaultArgs: ["--enable-automation"],
    viewport: null,  // use full window size, no fixed viewport
  });

  // Patch navigator.webdriver on every new page before any scripts run
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Navigate the default page to the target URL
  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  // When user closes the browser, dump cookies before the context is gone
  // We capture cookies when any page closes (last page close triggers context close)
  let cookiesDumped = false;
  context.on("page", () => {}); // keep context alive

  const dumpCookiesBeforeClose = async () => {
    if (cookiesDumped) return;
    cookiesDumped = true;
    try {
      const cookies = await context.cookies();
      writeLine({ event: "profile-data", cookies } as any);
    } catch {}
  };

  // Listen for page close — dump cookies when the last page closes
  context.on("page", (p) => {
    p.on("close", async () => {
      const remaining = context.pages();
      if (remaining.length <= 1) {
        await dumpCookiesBeforeClose();
      }
    });
  });

  // Also handle the initial page
  page.on("close", async () => {
    const remaining = context.pages();
    if (remaining.length <= 1) {
      await dumpCookiesBeforeClose();
    }
  });

  // Wait for the user to close all browser windows
  await new Promise<void>((resolve) => {
    context.on("close", () => resolve());
  });

  writeLine({ event: "browser-closed" } as any);
}

/**
 * Reads cookies and storage from the persistent browser profile.
 * Opens the context headlessly, reads data, and outputs it.
 */
export async function dumpProfile(rawUrl: string, profileDir?: string): Promise<void> {
  const url = ensureProtocol(rawUrl);
  const executablePath = findChromium();
  const userDataDir = getBrowserProfileDir(profileDir);

  if (!fs.existsSync(userDataDir)) {
    writeLine({ event: "profile-data", cookies: [], localStorage: {} } as any);
    return;
  }

  killChromeForProfile(userDataDir);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath,
    args: STEALTH_ARGS,
    ignoreDefaultArgs: ["--enable-automation"],
  });

  try {
    // Get all cookies
    const cookies = await context.cookies();

    // Try to get localStorage for the target domain
    let localStorage: Record<string, string> = {};
    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      localStorage = await page.evaluate(() => {
        const items: Record<string, string> = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          if (key) items[key] = window.localStorage.getItem(key) ?? "";
        }
        return items;
      });
      await page.close();
    } catch {}

    writeLine({ event: "profile-data", cookies, localStorage } as any);
  } finally {
    await context.close();
  }
}
