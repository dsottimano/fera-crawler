import { describe, it, expect } from "vitest";
import { mergeWithDefaults, buildDefaults } from "../../src/settings/defaults";

describe("mergeWithDefaults", () => {
  it("populates missing nested keys (regression: profile saved before perHostConcurrency existed)", () => {
    const stored = {
      crawling: { mode: "spider", concurrency: 5, maxRequests: 0, delay: 500, respectRobots: false, discoverSitemap: true },
      performance: { blockResources: true, closeOnExtract: true, sessionWarmup: true, perHostDelay: 2000, autoProbeOnBlock: true },
      // perHostConcurrency missing — would render as `undefined` in modal
      authentication: { headless: false },
      advanced: { debugLog: false },
    };
    const merged = mergeWithDefaults(stored);
    expect(merged.performance.perHostConcurrency).toBeTypeOf("number");
    expect(merged.performance.perHostDelay).toBe(2000); // stored wins
  });

  it("strips schema-retired keys (regression: advanced.perHostDelay zombie)", () => {
    const stored = {
      advanced: {
        perHostDelay: 500,         // retired in Phase 3
        perHostConcurrency: 2,     // retired in Phase 3
        debugLog: false,
      },
    };
    const merged = mergeWithDefaults(stored) as unknown as Record<string, Record<string, unknown>>;
    expect(merged.advanced).not.toHaveProperty("perHostDelay");
    expect(merged.advanced).not.toHaveProperty("perHostConcurrency");
    expect(merged.advanced).toHaveProperty("debugLog");
  });

  it("strips inputs.scraperUrl (regression: transient editor state)", () => {
    const stored = {
      inputs: {
        urls: ["a", "b"],
        customHeaders: {},
        scraperRules: [],
        scraperUrl: "https://test.com",
        recrawlQueue: [],
      },
    };
    const merged = mergeWithDefaults(stored) as unknown as { inputs: Record<string, unknown> };
    expect(merged.inputs).not.toHaveProperty("scraperUrl");
    expect(merged.inputs.urls).toEqual(["a", "b"]);
  });

  it("preserves free-form inputs.customHeaders verbatim", () => {
    const stored = {
      inputs: {
        urls: [],
        customHeaders: { "X-Custom": "v1", "Authorization": "Bearer xyz" },
        scraperRules: [],
        recrawlQueue: [],
      },
    };
    const merged = mergeWithDefaults(stored);
    expect(merged.inputs.customHeaders).toEqual({ "X-Custom": "v1", "Authorization": "Bearer xyz" });
  });

  it("missing inputs bucket entirely → seeded with defaults", () => {
    const stored = {
      crawling: { mode: "spider", concurrency: 5, maxRequests: 0, delay: 0, respectRobots: true, discoverSitemap: true },
    };
    const merged = mergeWithDefaults(stored);
    expect(merged.inputs).toEqual({
      urls: [],
      customHeaders: {},
      scraperRules: [],
      recrawlQueue: [],
    });
  });

  it("non-object input → returns full defaults", () => {
    const merged = mergeWithDefaults(null);
    expect(merged).toEqual(buildDefaults());
  });

  it("preserves stored array values wholesale (no per-element merge)", () => {
    const stored = { inputs: { urls: ["a", "b", "c"], customHeaders: {}, scraperRules: [], recrawlQueue: [] } };
    const merged = mergeWithDefaults(stored);
    expect(merged.inputs.urls).toEqual(["a", "b", "c"]);
  });
});
