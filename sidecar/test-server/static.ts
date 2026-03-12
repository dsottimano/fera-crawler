import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures");
const ASSETS_DIR = path.join(import.meta.dirname, "assets");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf",
};

function safePath(base: string, requested: string): string | null {
  const resolved = path.resolve(base, requested);
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

export function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  const urlPath = new URL(req.url ?? "/", "http://localhost").pathname;

  // Try assets/ first for /assets/* paths
  if (urlPath.startsWith("/assets/")) {
    const relative = urlPath.slice("/assets/".length);
    const filePath = safePath(ASSETS_DIR, relative);
    if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
      return true;
    }
  }

  // Serve from fixtures/
  let relative = urlPath === "/" ? "index.html" : urlPath.slice(1);
  // Add .html extension if no extension present
  if (!path.extname(relative)) {
    relative += ".html";
  }

  const filePath = safePath(FIXTURES_DIR, relative);
  if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  return false;
}
