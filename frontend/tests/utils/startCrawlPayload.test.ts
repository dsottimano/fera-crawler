import { describe, it, expect } from "vitest";
import { buildStartCrawlPayload } from "../../src/utils/startCrawlPayload";
import { buildDefaults } from "../../src/settings/defaults";
import type { SettingsValues } from "../../src/settings/types";

function withInputs(patch: Partial<SettingsValues["inputs"]>): SettingsValues {
  const v = buildDefaults();
  Object.assign(v.inputs, patch);
  return v;
}

describe("buildStartCrawlPayload", () => {
  it("uses snapshot's settings — never silently mixes other state", () => {
    const s = buildDefaults();
    s.crawling.concurrency = 7;
    s.crawling.delay = 1234;
    s.performance.perHostDelay = 999;
    s.authentication.headless = true;

    const p = buildStartCrawlPayload("https://x.com", s);
    expect(p.concurrency).toBe(7);
    expect(p.delay).toBe(1234);
    expect(p.perHostDelay).toBe(999);
    expect(p.headless).toBe(true);
  });

  it("empty customHeaders → null (not '{}'), so sidecar can skip the flag entirely", () => {
    const p = buildStartCrawlPayload("https://x.com", buildDefaults());
    expect(p.customHeaders).toBe(null);
  });

  it("non-empty customHeaders → JSON string", () => {
    const s = withInputs({ customHeaders: { "X-Foo": "bar" } });
    const p = buildStartCrawlPayload("https://x.com", s);
    expect(p.customHeaders).toBe('{"X-Foo":"bar"}');
  });

  it("empty inputs.urls → null (so spider mode doesn't get an empty list)", () => {
    const p = buildStartCrawlPayload("https://x.com", buildDefaults());
    expect(p.urls).toBe(null);
  });

  it("non-empty inputs.urls passed through", () => {
    const s = withInputs({ urls: ["a", "b"] });
    const p = buildStartCrawlPayload("https://x.com", s);
    expect(p.urls).toEqual(["a", "b"]);
  });

  it("opts.urls override inputs.urls (recrawl path)", () => {
    const s = withInputs({ urls: ["a", "b"] });
    const p = buildStartCrawlPayload("https://x.com", s, { urls: ["c"] });
    expect(p.urls).toEqual(["c"]);
  });

  it("opts.mode override (Exact-URL scope)", () => {
    const s = buildDefaults();
    s.crawling.mode = "spider";
    const p = buildStartCrawlPayload("https://x.com", s, { mode: "list", urls: ["x"] });
    expect(p.mode).toBe("list");
  });

  it("opts.maxRequests override", () => {
    const s = buildDefaults();
    s.crawling.maxRequests = 0;
    const p = buildStartCrawlPayload("https://x.com", s, { maxRequests: 50 });
    expect(p.maxRequests).toBe(50);
  });

  it("excludeUrls iterable → array; empty → null", () => {
    const s = buildDefaults();
    const p1 = buildStartCrawlPayload("https://x.com", s, { excludeUrls: new Set(["a", "b"]) });
    expect(p1.excludeUrls?.sort()).toEqual(["a", "b"]);
    const p2 = buildStartCrawlPayload("https://x.com", s, { excludeUrls: new Set() });
    expect(p2.excludeUrls).toBe(null);
  });

  it("stealth.userAgent override surfaces as userAgent; rest stays in stealthConfig", () => {
    const s = buildDefaults();
    s.stealth.userAgent = "TestUA/1.0";
    s.stealth.enabled = true;
    const p = buildStartCrawlPayload("https://x.com", s);
    expect(p.userAgent).toBe("TestUA/1.0");
    // stealthConfig should NOT include userAgent (it's stripped before serializing)
    expect(p.stealthConfig).not.toContain("TestUA");
    expect(p.stealthConfig).toContain('"enabled":true');
  });

  it("empty userAgent → null", () => {
    const p = buildStartCrawlPayload("https://x.com", buildDefaults());
    expect(p.userAgent).toBe(null);
  });

  it("downloadOgImage off → null (not false), so sidecar treats it as 'not requested'", () => {
    const p = buildStartCrawlPayload("https://x.com", buildDefaults());
    expect(p.downloadOgImage).toBe(null);
  });

  it("downloadOgImage on → true", () => {
    const s = buildDefaults();
    s.extraction.downloadOgImage = true;
    const p = buildStartCrawlPayload("https://x.com", s);
    expect(p.downloadOgImage).toBe(true);
  });

  it("scraperRules empty → null; non-empty → JSON string", () => {
    const s = withInputs({ scraperRules: [{ name: "r1", selector: ".x" }] });
    const p = buildStartCrawlPayload("https://x.com", s);
    expect(p.scraperRules).toBe('[{"name":"r1","selector":".x"}]');
    const empty = buildStartCrawlPayload("https://x.com", buildDefaults());
    expect(empty.scraperRules).toBe(null);
  });

  it("forwards perHostDelay and perHostDelayMax", () => {
    const s = buildDefaults();
    s.performance.perHostDelay = 750;
    s.performance.perHostDelayMax = 2250;
    const p = buildStartCrawlPayload("https://x.com", s);
    expect(p.perHostDelay).toBe(750);
    expect(p.perHostDelayMax).toBe(2250);
  });

  it("regression: pinned snapshot's inputs.urls survives instead of caller's defaults", () => {
    // Simulates resuming a saved list-mode crawl: caller passes the pinned
    // SettingsValues blob (with its 32k URLs). buildStartCrawlPayload must
    // use those, not anything else.
    const pinned = withInputs({ urls: Array.from({ length: 32601 }, (_, i) => `https://x/${i}`) });
    const p = buildStartCrawlPayload("https://x.com", pinned);
    expect(p.urls?.length).toBe(32601);
  });

  it("sessionId: caller-supplied id flows through; Rust uses it to attribute crawl-result rows", () => {
    const p = buildStartCrawlPayload("https://x.com", buildDefaults(), { sessionId: 4242 });
    expect(p.sessionId).toBe(4242);
  });

  it("sessionId: defaults to 0 when omitted (Rust treats 0 as 'no session attached')", () => {
    const p = buildStartCrawlPayload("https://x.com", buildDefaults());
    expect(p.sessionId).toBe(0);
  });
});
