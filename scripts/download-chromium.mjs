#!/usr/bin/env node
/**
 * Downloads the Playwright-compatible Chromium build for the current platform
 * and copies it to src-tauri/chromium/ for bundling with the Tauri app.
 *
 * Usage: node scripts/download-chromium.mjs [--target <platform>]
 *   --target: linux, win32, darwin (defaults to current platform)
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TAURI_DIR = path.join(ROOT, "src-tauri");
const CHROMIUM_OUT = path.join(TAURI_DIR, "chromium");

const targetArg = process.argv.indexOf("--target");
const platform = targetArg !== -1 ? process.argv[targetArg + 1] : process.platform;

function findPlaywrightCache() {
  // Playwright stores browsers in platform-specific cache dirs
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ms-playwright");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Caches", "ms-playwright");
  }
  // Linux
  return path.join(home, ".cache", "ms-playwright");
}

function findChromiumInCache(cacheDir) {
  if (!fs.existsSync(cacheDir)) return null;

  // Look for chromium-* directories
  const entries = fs.readdirSync(cacheDir).filter((e) => e.startsWith("chromium-"));
  if (entries.length === 0) return null;

  // Use the latest revision
  entries.sort();
  const chromiumDir = path.join(cacheDir, entries[entries.length - 1]);

  // Platform-specific binary paths within the Playwright cache
  if (platform === "win32") {
    const exe = path.join(chromiumDir, "chrome-win", "chrome.exe");
    if (fs.existsSync(exe)) return path.join(chromiumDir, "chrome-win");
  } else if (platform === "darwin") {
    const app = path.join(chromiumDir, "chrome-mac", "Chromium.app");
    if (fs.existsSync(app)) return path.join(chromiumDir, "chrome-mac");
  } else {
    const bin = path.join(chromiumDir, "chrome-linux", "chrome");
    if (fs.existsSync(bin)) return path.join(chromiumDir, "chrome-linux");
  }

  return null;
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(srcPath);
      fs.symlinkSync(target, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      // Preserve executable permissions
      const stat = fs.statSync(srcPath);
      fs.chmodSync(destPath, stat.mode);
    }
  }
}

console.log(`[download-chromium] Platform: ${platform}`);

// Step 1: Install Chromium via Playwright
console.log("[download-chromium] Installing Patchright Chromium...");
try {
  execSync("npx patchright install chromium", {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" }, // Use default cache
  });
} catch (err) {
  console.error("[download-chromium] Failed to install Chromium via Patchright");
  process.exit(1);
}

// Step 2: Find the downloaded Chromium
const cacheDir = findPlaywrightCache();
console.log(`[download-chromium] Playwright cache: ${cacheDir}`);

const chromiumSrc = findChromiumInCache(cacheDir);
if (!chromiumSrc) {
  console.error("[download-chromium] Could not find Chromium in Playwright cache");
  process.exit(1);
}

console.log(`[download-chromium] Found Chromium at: ${chromiumSrc}`);

// Step 3: Copy to src-tauri/chromium/
if (fs.existsSync(CHROMIUM_OUT)) {
  fs.rmSync(CHROMIUM_OUT, { recursive: true });
}

console.log(`[download-chromium] Copying to: ${CHROMIUM_OUT}`);
copyRecursive(chromiumSrc, CHROMIUM_OUT);

// Verify the binary exists in the output
const binaryName = platform === "win32" ? "chrome.exe" : platform === "darwin" ? "Chromium.app/Contents/MacOS/Chromium" : "chrome";
const binaryPath = path.join(CHROMIUM_OUT, binaryName);

if (fs.existsSync(binaryPath)) {
  const size = fs.statSync(binaryPath).size;
  console.log(`[download-chromium] OK — ${binaryName} (${(size / 1024 / 1024).toFixed(1)} MB)`);
} else {
  console.error(`[download-chromium] ERROR — binary not found at ${binaryPath}`);
  process.exit(1);
}

console.log("[download-chromium] Done.");
