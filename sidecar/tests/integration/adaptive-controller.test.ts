import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { PerHostRateLimiter } from "../../src/rate-limiter.js";
import { PerHostStates } from "../../src/perHostState.js";
import { AdaptiveController, type ControllerEvent } from "../../src/adaptiveController.js";
import { BlockDetector } from "../../src/blockDetector.js";
import { classifyResponse } from "../../src/responseClassifier.js";

const TEST_PORT = 5099;
const BASE = `http://localhost:${TEST_PORT}`;
let serverProc: ChildProcessWithoutNullStreams;

function waitForServer(timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = async () => {
      try {
        const r = await fetch(`${BASE}/scripted?script=normal`);
        if (r.ok) {
          resolve();
          return;
        }
      } catch {
        // Server not up yet
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Test server did not start within ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

async function fetchPage(url: string): Promise<{ status: number; title: string; bodyBytes: number }> {
  const r = await fetch(url);
  const body = await r.text();
  const m = body.match(/<title>([^<]*)<\/title>/i);
  return { status: r.status, title: m?.[1] ?? "", bodyBytes: body.length };
}

beforeAll(async () => {
  const cwd = path.resolve(import.meta.dirname, "../..");
  serverProc = spawn("npx", ["tsx", "test-server/server.ts"], {
    cwd,
    env: { ...process.env, TEST_PORT: String(TEST_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stderr.on("data", (d) => console.error(`[test-server stderr] ${d}`));
  await waitForServer();
}, 15_000);

afterAll(async () => {
  if (serverProc) {
    serverProc.kill();
    await new Promise<void>((resolve) => serverProc.once("exit", () => resolve()));
  }
});

describe("AdaptiveController integration", () => {
  it("403 burst from real HTTP triggers re-probe-requested", async () => {
    const rl = new PerHostRateLimiter({ delayMinMs: 50, maxConcurrency: 4 });
    const states = new PerHostStates();
    const events: ControllerEvent[] = [];
    const ctrl = new AdaptiveController({
      rateLimiter: rl,
      states,
      delayMinMs: 50,
      onEvent: (e) => events.push(e),
    });
    const detector = new BlockDetector({ cooldownsMs: [] });
    const host = `localhost:${TEST_PORT}`;

    for (let i = 0; i < 10; i++) {
      const url = `${BASE}/scripted?script=403&i=${i}`;
      const r = await fetchPage(url);
      const cls = classifyResponse(
        { url, status: r.status, title: r.title, bodyBytes: r.bodyBytes, internalLinks: 0 },
        host,
        detector,
        states.baseline(host),
      );
      states.recordClassification(host, cls);
      ctrl.tick(host, cls, { url, bodyBytes: r.bodyBytes, internalLinks: 0 });
    }

    const reprobe = events.find((e) => e.type === "re-probe-requested");
    expect(reprobe).toBeDefined();
    expect((reprobe as any).reason).toBe("403-burst");
  }, 30_000);

  it("captcha title (200 + block phrase) classifies as blocked-content and steps up", async () => {
    const rl = new PerHostRateLimiter({ delayMinMs: 100, maxConcurrency: 1 });
    const states = new PerHostStates();
    const ctrl = new AdaptiveController({
      rateLimiter: rl,
      states,
      delayMinMs: 100,
      onEvent: () => {},
    });
    const detector = new BlockDetector({ cooldownsMs: [] });
    const host = `localhost:${TEST_PORT}`;

    const url = `${BASE}/scripted?script=captcha`;
    const r = await fetchPage(url);
    const cls = classifyResponse(
      { url, status: r.status, title: r.title, bodyBytes: r.bodyBytes, internalLinks: 0 },
      host,
      detector,
      null,
    );
    expect(cls).toBe("blocked-content");
    states.recordClassification(host, cls);
    const before = rl.getMultiplier(host);
    ctrl.tick(host, cls, { url, bodyBytes: r.bodyBytes, internalLinks: 0 });
    expect(rl.getMultiplier(host)).toBeGreaterThan(before);
  }, 30_000);
});
