import { describe, it, expect } from "vitest";
import { decideCompletion } from "../../src/utils/completionStatus";

describe("decideCompletion", () => {
  it("list-mode resume that re-fired complete with no new results is STOPPED, not complete", () => {
    // Session 72 scenario: 32601 queued, 8546 already crawled cleanly, user
    // hits Resume, sidecar emits crawl-complete because excludeUrls covered
    // every remaining URL. Frontend used to call completeSession here.
    const d = decideCompletion({ rowCount: 8546, errorCount: 0, listTotal: 32601 });
    expect(d.isStopped).toBe(true);
    expect(d.incompleteList).toBe(true);
    expect(d.hadFailures).toBe(false);
  });

  it("clean list-mode completion (rowCount === listTotal) is COMPLETE", () => {
    const d = decideCompletion({ rowCount: 50, errorCount: 0, listTotal: 50 });
    expect(d.isStopped).toBe(false);
    expect(d.incompleteList).toBe(false);
  });

  it("any failure marks STOPPED even with full coverage", () => {
    // Caller computes errorCount = errors + status_4xx + status_5xx + status_other
    // before invoking — semantics preserved end-to-end via aggregate_health.
    const d = decideCompletion({ rowCount: 3, errorCount: 1, listTotal: 3 });
    expect(d.isStopped).toBe(true);
    expect(d.hadFailures).toBe(true);
  });

  it("spider mode (listTotal=0) is COMPLETE on clean run", () => {
    const d = decideCompletion({ rowCount: 3, errorCount: 0, listTotal: 0 });
    expect(d.isStopped).toBe(false);
    expect(d.incompleteList).toBe(false);
  });

  it("spider mode with one failure is STOPPED", () => {
    const d = decideCompletion({ rowCount: 100, errorCount: 5, listTotal: 0 });
    expect(d.isStopped).toBe(true);
    expect(d.hadFailures).toBe(true);
  });
});
