import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

const fixturesDir = path.join(import.meta.dirname, "fixtures");

export const routes = new Map<string, RouteHandler>();

// Scraper test page
routes.set("/scraper", (_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  fs.createReadStream(path.join(fixturesDir, "scraper-page.html")).pipe(res);
});

// 301 redirect
routes.set("/redirect-301", (_req, res) => {
  res.writeHead(301, { Location: "/" });
  res.end();
});

// Multi-hop redirect chain: /chain-a -> /chain-b -> /chain-c -> /
routes.set("/chain-a", (_req, res) => {
  res.writeHead(301, { Location: "/chain-b" });
  res.end();
});
routes.set("/chain-b", (_req, res) => {
  res.writeHead(302, { Location: "/chain-c" });
  res.end();
});
routes.set("/chain-c", (_req, res) => {
  res.writeHead(301, { Location: "/" });
  res.end();
});

// Page with JS error, console.error, and failed subresource
routes.set("/page-with-errors", (_req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    // No security headers intentionally, so audit shows false across the board
  });
  res.end(`<html><head><title>Errors</title>
    <link rel="alternate" hreflang="en-us" href="http://localhost:5000/en/">
    <link rel="alternate" hreflang="fr-fr" href="http://localhost:5000/fr/">
    <script type="application/ld+json">{"@type":"Article","headline":"x"}</script>
    <script type="application/ld+json">{"@type":["WebSite","Organization"]}</script>
    </head><body>
    <h1>Error page</h1>
    <img src="/does-not-exist.png">
    <script>
      console.error("this is a console error");
      throw new Error("boom from inline script");
    </script>
    </body></html>`);
});

// Page with all security headers set
routes.set("/secure-page", (_req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Strict-Transport-Security": "max-age=31536000",
    "Content-Security-Policy": "default-src 'self'",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Permissions-Policy": "geolocation=()",
  });
  res.end("<html><head><title>Secure</title></head><body><h1>secure</h1></body></html>");
});

// 302 redirect
routes.set("/redirect-302", (_req, res) => {
  res.writeHead(302, { Location: "/" });
  res.end();
});

// 404 error page
routes.set("/error-404", (_req, res) => {
  res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<html><head><title>Not Found</title></head><body><h1>404 Not Found</h1></body></html>");
});

// 500 error page
routes.set("/error-500", (_req, res) => {
  res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<html><head><title>Server Error</title></head><body><h1>500 Internal Server Error</h1></body></html>");
});

// Slow response with configurable delay
routes.set("/slow", (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const delay = Math.min(parseInt(url.searchParams.get("delay") ?? "1000", 10), 30000);
  setTimeout(() => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<html><head><title>Slow Page</title></head><body><h1>Slow Response</h1></body></html>");
  }, delay);
});

// Custom headers route
routes.set("/custom-headers", (_req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "X-Custom-Header": "test-value",
    "X-Robots-Tag": "noindex",
  });
  res.end("<html><head><title>Custom Headers</title></head><body><h1>Custom Headers Page</h1></body></html>");
});

// X-Robots-Tag noindex (via header only, no meta)
routes.set("/x-robots-noindex", (_req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "X-Robots-Tag": "noindex, nofollow",
  });
  res.end("<html><head><title>X-Robots Noindex</title><meta name=\"description\" content=\"Blocked by header\"></head><body><h1>X-Robots Header</h1></body></html>");
});
