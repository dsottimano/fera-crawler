import { describe, it, expect } from "vitest";
import { decideCompletion } from "../../src/utils/completionStatus";
import type { CrawlResult } from "../../src/types/crawl";

function ok(url: string): CrawlResult {
  return {
    url, status: 200, title: "", h1: "", h2: "",
    metaDescription: "", canonical: "", wordCount: 0,
    metaRobots: "", metaGooglebot: "", xRobotsTag: "",
    isIndexable: true, isNoindex: false, isNofollow: false,
    ogTitle: "", ogDescription: "", ogType: "", ogUrl: "",
    ogImage: "", ogImageWidth: 0, ogImageHeight: 0,
    ogImageWidthReal: 0, ogImageHeightReal: 0, ogImageRatio: 0, ogImageFileSize: 0,
    datePublished: "", dateModified: "", datePublishedTime: "", dateModifiedTime: "",
    internalLinks: 0, externalLinks: 0, outlinks: [],
    responseTime: 0, contentType: "text/html", resourceType: "HTML",
    size: 0, metaTags: [], scraper: {},
  };
}
function fail(url: string, status = 500): CrawlResult {
  return { ...ok(url), status, error: "boom" };
}

describe("decideCompletion", () => {
  it("list-mode resume that re-fired complete with no new results is STOPPED, not complete", () => {
    // Session 72 scenario: 32601 queued, 8546 already crawled cleanly, user
    // hits Resume, sidecar emits crawl-complete because excludeUrls covered
    // every remaining URL. Frontend used to call completeSession here.
    const results: CrawlResult[] = Array.from({ length: 8546 }, (_, i) => ok(`https://x/${i}`));
    const d = decideCompletion({ results, listTotal: 32601 });
    expect(d.isStopped).toBe(true);
    expect(d.incompleteList).toBe(true);
    expect(d.hadFailures).toBe(false);
  });

  it("clean list-mode completion (results === listTotal) is COMPLETE", () => {
    const results = Array.from({ length: 50 }, (_, i) => ok(`https://x/${i}`));
    const d = decideCompletion({ results, listTotal: 50 });
    expect(d.isStopped).toBe(false);
    expect(d.incompleteList).toBe(false);
  });

  it("any failure (4xx/5xx) marks STOPPED even with full coverage", () => {
    const results = [ok("a"), fail("b", 503), ok("c")];
    const d = decideCompletion({ results, listTotal: 3 });
    expect(d.isStopped).toBe(true);
    expect(d.hadFailures).toBe(true);
  });

  it("network failure (status=0) marks STOPPED", () => {
    const results = [ok("a"), { ...ok("b"), status: 0 }];
    const d = decideCompletion({ results, listTotal: 2 });
    expect(d.isStopped).toBe(true);
    expect(d.hadFailures).toBe(true);
  });

  it("spider mode (listTotal=0) is COMPLETE on clean run", () => {
    const results = [ok("a"), ok("b"), ok("c")];
    const d = decideCompletion({ results, listTotal: 0 });
    expect(d.isStopped).toBe(false);
    expect(d.incompleteList).toBe(false);
  });
});
