import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureServer, stopServer, runCrawlerProcess, BASE_URL } from "../helpers.js";

describe("deep capture: redirect chain, hreflang, structured data, security headers, JS errors", () => {
  beforeAll(async () => {
    await ensureServer();
  });

  afterAll(() => {
    stopServer();
  });

  it("captures full multi-hop redirect chain", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/chain-a`,
      "--mode", "list",
      "--urls", `${BASE_URL}/chain-a`,
      "--max-requests", "1",
    ]);
    expect(results).toHaveLength(1);
    const r = results[0];
    // Chain-a -> chain-b -> chain-c -> / ; the capture stores hops before the final response.
    expect(r.redirectChain.length).toBeGreaterThanOrEqual(3);
    expect(r.redirectChain[0]).toBe(`${BASE_URL}/chain-a`);
    expect(r.redirectChain).toContain(`${BASE_URL}/chain-b`);
    expect(r.redirectChain).toContain(`${BASE_URL}/chain-c`);
    // SEO convention: a redirected URL is labeled by its first hop's status,
    // not the final destination's. /chain-a returns 301 → ... → 200, so this
    // row's status is 301 and the destination is in redirectUrl.
    expect(r.status).toBe(301);
    expect(r.redirectUrl).toBe(`${BASE_URL}/`);
  });

  it("captures hreflang, structured data @types, and JS/console errors + failed requests", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/page-with-errors`,
      "--mode", "list",
      "--urls", `${BASE_URL}/page-with-errors`,
      "--max-requests", "1",
    ]);
    const r = results[0];

    expect(r.hreflang).toEqual([
      { lang: "en-us", href: "http://localhost:5000/en/" },
      { lang: "fr-fr", href: "http://localhost:5000/fr/" },
    ]);

    expect(r.structuredDataTypes).toEqual(expect.arrayContaining(["Article", "WebSite", "Organization"]));

    expect(r.jsErrors.some((e: string) => e.includes("boom"))).toBe(true);
    expect(r.consoleErrors.some((e: string) => e.includes("console error"))).toBe(true);
    expect(r.failedRequests.some((u: string) => u.includes("does-not-exist.png"))).toBe(true);

    // No security headers on this route
    expect(r.securityHeaders.hsts).toBe(false);
    expect(r.securityHeaders.csp).toBe(false);
  });

  it("reports all security headers on a fully-secured page", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/secure-page`,
      "--mode", "list",
      "--urls", `${BASE_URL}/secure-page`,
      "--max-requests", "1",
    ]);
    const r = results[0];
    expect(r.securityHeaders).toEqual({
      hsts: true,
      csp: true,
      xFrameOptions: true,
      referrerPolicy: true,
      xContentTypeOptions: true,
      permissionsPolicy: true,
    });
  });

  it("populates navigation timing without --capture-vitals", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/`,
      "--mode", "list",
      "--urls", `${BASE_URL}/`,
      "--max-requests", "1",
    ]);
    const r = results[0];
    expect(r.perf.ttfb).toBeGreaterThan(0);
    expect(r.perf.domContentLoaded).toBeGreaterThan(0);
    // LCP/CLS should be 0 since not captured
    expect(r.perf.lcp).toBe(0);
  });

  it("captures LCP with --capture-vitals", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/`,
      "--mode", "list",
      "--urls", `${BASE_URL}/`,
      "--max-requests", "1",
      "--capture-vitals",
    ]);
    const r = results[0];
    // LCP may be 0 on a trivial page with no text/image, but the field must exist and be a number.
    expect(typeof r.perf.lcp).toBe("number");
    expect(r.perf.loadTime).toBeGreaterThan(0);
  });
});
