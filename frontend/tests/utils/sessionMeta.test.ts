import { describe, it, expect } from "vitest";
import { sessionMeta } from "../../src/utils/sessionMeta";

describe("sessionMeta", () => {
  it("recognises list-mode coverage gap on the unified shape (regression: cfg.inputs.urls)", () => {
    // Session 72 in real life: list-mode crawl, 32601 queued, 8546 crawled,
    // marked completed_at. Before the fix this rendered as SPIDER 8,546 /
    // COMPLETE because sessionMeta was reading cfg.urls (legacy path) and
    // finding nothing.
    const meta = sessionMeta({
      config_json: JSON.stringify({
        crawling: { mode: "spider" },
        inputs: { urls: new Array(32601).fill("https://x") },
      }),
      completed_at: "2026-04-27 21:52:22",
      result_count: 8546,
    });
    expect(meta.mode).toBe("list");
    expect(meta.listTotal).toBe(32601);
    expect(meta.status).toBe("stopped");
    expect(meta.progressLabel).toBe("8,546 / 32,601 URLs");
  });

  it("recognises list mode on the legacy CrawlConfig shape", () => {
    const meta = sessionMeta({
      config_json: JSON.stringify({
        urls: ["https://a", "https://b", "https://c"],
        customHeaders: {},
        scraperRules: [],
        recrawlQueue: [],
      }),
      completed_at: null,
      result_count: 1,
    });
    expect(meta.mode).toBe("list");
    expect(meta.listTotal).toBe(3);
    expect(meta.status).toBe("in progress");
    expect(meta.progressLabel).toBe("1 / 3 URLs");
  });

  it("falls back to spider mode when no urls list is present", () => {
    const meta = sessionMeta({
      config_json: JSON.stringify({
        crawling: { mode: "spider" },
        inputs: { urls: [] },
      }),
      completed_at: "2026-01-01 00:00:00",
      result_count: 100,
    });
    expect(meta.mode).toBe("spider");
    expect(meta.listTotal).toBe(null);
    expect(meta.status).toBe("complete");
    expect(meta.progressLabel).toBe("100 URLs");
  });

  it("clean list-mode completion (crawled === total) shows COMPLETE", () => {
    const meta = sessionMeta({
      config_json: JSON.stringify({
        inputs: { urls: ["a", "b", "c"] },
      }),
      completed_at: "2026-01-01 00:00:00",
      result_count: 3,
    });
    expect(meta.mode).toBe("list");
    expect(meta.status).toBe("complete");
  });

  it("missing config_json is treated as spider", () => {
    const meta = sessionMeta({
      config_json: undefined,
      completed_at: null,
      result_count: 0,
    });
    expect(meta.mode).toBe("spider");
    expect(meta.status).toBe("in progress");
  });

  it("malformed config_json is tolerated", () => {
    const meta = sessionMeta({
      config_json: "{not json",
      completed_at: null,
      result_count: 0,
    });
    expect(meta.mode).toBe("spider");
  });

  it("uses pre-computed list_total when present (skips JSON.parse hot path)", () => {
    // SQL JSON1 query supplies list_total directly; sessionMeta should NOT
    // need config_json at all in this case. Pass a deliberately broken
    // config_json to prove it's not being consulted.
    const meta = sessionMeta({
      list_total: 32601,
      config_json: "{\"this\":\"will throw if parsed,maybe\":}",
      completed_at: "2026-04-27 21:52:22",
      result_count: 8546,
    });
    expect(meta.mode).toBe("list");
    expect(meta.listTotal).toBe(32601);
    expect(meta.status).toBe("stopped");
    expect(meta.progressLabel).toBe("8,546 / 32,601 URLs");
  });

  it("list_total = 0 (spider crawl in SQL) is treated as no list", () => {
    const meta = sessionMeta({
      list_total: 0,
      completed_at: null,
      result_count: 100,
    });
    expect(meta.mode).toBe("spider");
    expect(meta.listTotal).toBe(null);
  });
});
