import path from "node:path";
import os from "node:os";

const home = os.homedir();
const platform = process.platform;

function appDataDir(): string {
  if (platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "com.fera.crawler");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "com.fera.crawler");
  }
  return path.join(home, ".local", "share", "com.fera.crawler");
}

export const APP_DATA = appDataDir();
export const DB_PATH = path.join(APP_DATA, "fera.db");
export const OG_IMAGES_DIR = path.join(APP_DATA, "og-images");
export const SIDECAR_DIR = path.join(import.meta.dirname, "..", "..", "sidecar");
export const SIDECAR_ENTRY = path.join(SIDECAR_DIR, "src", "index.ts");
