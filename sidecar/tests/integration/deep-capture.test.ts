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
    // chain-a -> chain-b -> chain-c -> / ; the chain runs origin → destination,
    // so the final URL terminates it rather than being dropped.
    expect(r.redirectChain).toEqual([
      `${BASE_URL}/chain-a`,
      `${BASE_URL}/chain-b`,
      `${BASE_URL}/chain-c`,
      `${BASE_URL}/`,
    ]);
    // SEO convention: a redirected URL is labeled by its first hop's status,
    // not the final destination's. /chain-a returns 301 → ... → 200, so this
    // row's status is 301 and the destination is in redirectUrl.
    expect(r.status).toBe(301);
    expect(r.redirectUrl).toBe(`${BASE_URL}/`);
    // Every other field on the row describes the destination, so the first
    // hop's own headers are captured separately — without them the `Location`
    // that produced the redirect is unrecoverable from the stored data.
    expect(r.redirectHeaders?.location).toBe("/chain-b");
    expect(r.redirectHeaders?.["x-hop"]).toBe("a");
    // `status` is the first hop's, so `server` must be too. The destination
    // sends no Server header at all, so this is 301's or nothing.
    expect(r.serverHeader).toBe("hop-a-server");
  });

  it("leaves redirectHeaders empty for a non-redirected response", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/scraper`,
      "--mode", "list",
      "--urls", `${BASE_URL}/scraper`,
      "--max-requests", "1",
    ]);
    const r = results[0];
    expect(r.status).toBe(200);
    expect(r.redirectChain).toEqual([]);
    expect(r.redirectHeaders ?? {}).toEqual({});
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

    // NOTE: page-emitted console.error is NOT asserted here — see the skipped
    // test below. Only browser-emitted console messages (network failures, CSP
    // refusals) survive Patchright's stealth patches.

    // Resource blocking is off here, so both 404s are genuine and reported.
    expect(r.failedRequests.some((u: string) => u.includes("does-not-exist.js"))).toBe(true);
    expect(r.failedRequests.some((u: string) => u.includes("does-not-exist.png"))).toBe(true);
    // Each broken URL is recorded once even though it can surface on both the
    // requestfailed and the response path.
    expect(new Set(r.failedRequests).size).toBe(r.failedRequests.length);

    // No security headers on this route
    expect(r.securityHeaders.hsts).toBe(false);
    expect(r.securityHeaders.csp).toBe(false);
  });

  it("does not report its own blocked subresources as site failures", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/page-with-errors`,
      "--mode", "list",
      "--urls", `${BASE_URL}/page-with-errors`,
      "--max-requests", "1",
      "--block-resources",
    ]);
    const r = results[0];

    // The image is aborted by our own blockResources route, so it never reaches
    // the server — reporting it would be a false positive. This accounted for
    // ~90% of both arrays before the ERR_BLOCKED_BY_CLIENT filter.
    expect(r.failedRequests.some((u: string) => u.includes("does-not-exist.png"))).toBe(false);
    expect(r.consoleErrors.some((e: string) => e.includes("ERR_BLOCKED_BY_CLIENT"))).toBe(false);
    expect(r.consoleErrors.some((e: string) => e.includes("ERR_FAILED"))).toBe(false);

    // ...but a non-blocked resource type failing for real is still reported.
    expect(r.failedRequests.some((u: string) => u.includes("does-not-exist.js"))).toBe(true);
  });

  // KNOWN LIMITATION of the Patchright engine — pre-existing, and NOT worth
  // "fixing": patchright-core subscribes to Runtime.consoleAPICalled and
  // Runtime.exceptionThrown (crPage.js:361-362) but never sends Runtime.enable,
  // which is what makes Chrome emit them. Runtime.enable is one of the loudest
  // bot-detection signals, so the omission is deliberate stealth.
  //
  // Consequence for exported data:
  //   - jsErrors is empty on EVERY page (a 3,708-URL crawl was 100% empty)
  //   - consoleErrors only ever holds browser-emitted messages (failed
  //     subresources, CSP refusals) — never the page's own console.error
  //
  // Enabling Runtime would trade the crawler's anti-bot posture for these two
  // fields. Left skipped so the limitation stays visible rather than silent.
  it.skip("captures page-emitted console.error and uncaught exceptions", async () => {
    const results = await runCrawlerProcess([
      "crawl", `${BASE_URL}/page-with-errors`,
      "--mode", "list",
      "--urls", `${BASE_URL}/page-with-errors`,
      "--max-requests", "1",
    ]);
    expect(results[0].consoleErrors.some((e: string) => e.includes("console error"))).toBe(true);
    expect(results[0].jsErrors.some((e: string) => e.includes("boom"))).toBe(true);
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
