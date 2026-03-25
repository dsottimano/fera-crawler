import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import path from "node:path";
import type { CrawlResult } from "../src/types.js";

const SERVER_PORT = 5000;
const BASE_URL = `http://localhost:${SERVER_PORT}`;

let serverProcess: ChildProcess | null = null;

/** Start the test server if it isn't already running. */
export async function ensureServer(): Promise<void> {
  // Check if something is already listening on the port
  const alive = await checkPort(SERVER_PORT);
  if (alive) return;

  const serverPath = path.join(import.meta.dirname, "..", "test-server", "server.ts");
  serverProcess = spawn("npx", ["tsx", serverPath], {
    cwd: path.join(import.meta.dirname, ".."),
    stdio: "pipe",
    env: { ...process.env, TEST_PORT: String(SERVER_PORT) },
  });

  // Wait for server to be ready
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (await checkPort(SERVER_PORT)) return;
  }

  throw new Error("Test server failed to start within 5s");
}

/** Stop the test server if we started it. */
export function stopServer(): void {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

/** Run the crawler as a subprocess and return parsed NDJSON results. */
export async function runCrawlerProcess(args: string[]): Promise<CrawlResult[]> {
  const indexPath = path.join(import.meta.dirname, "..", "src", "index.ts");
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["tsx", indexPath, ...args], {
      cwd: path.join(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Crawler exited with code ${code}: ${stderr}`));
        return;
      }
      const results: CrawlResult[] = [];
      for (const line of stdout.trim().split("\n")) {
        if (line.trim()) {
          try {
            results.push(JSON.parse(line));
          } catch {
            // skip non-JSON lines
          }
        }
      }
      resolve(results);
    });

    proc.on("error", reject);
  });
}

/** Find a result by URL in the results array. */
export function findResult(results: CrawlResult[], urlPath: string): CrawlResult | undefined {
  const full = urlPath.startsWith("http") ? urlPath : `${BASE_URL}${urlPath}`;
  return results.find((r) => r.url === full);
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/`, () => {
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { BASE_URL };
