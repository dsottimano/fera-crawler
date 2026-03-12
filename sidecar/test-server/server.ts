import http from "node:http";
import { routes } from "./routes.js";
import { serveStatic } from "./static.js";

const PORT = parseInt(process.env.TEST_PORT ?? "5000", 10);

const server = http.createServer((req, res) => {
  const urlPath = new URL(req.url ?? "/", "http://localhost").pathname;

  // Check programmatic routes first
  const handler = routes.get(urlPath);
  if (handler) {
    handler(req, res);
    return;
  }

  // Fall back to static file serving
  if (serveStatic(req, res)) {
    return;
  }

  // 404 fallback
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`Test server running at http://localhost:${PORT}`);
});

export { server, PORT };
