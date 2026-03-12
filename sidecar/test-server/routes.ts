import type { IncomingMessage, ServerResponse } from "node:http";

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

export const routes = new Map<string, RouteHandler>();

// 301 redirect
routes.set("/redirect-301", (_req, res) => {
  res.writeHead(301, { Location: "/" });
  res.end();
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
  const delay = parseInt(url.searchParams.get("delay") ?? "1000", 10);
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
