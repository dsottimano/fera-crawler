import { describe, it, expect } from "vitest";
import { decideCompletion } from "../../src/utils/completionStatus";

describe("decideCompletion", () => {
  it("list-mode resume that re-fired complete with no new results is STOPPED, not complete", () => {
    // Session 72 scenario: 32601 queued, 8546 already crawled cleanly, user
    // hits Resume, sidecar emits crawl-complete because excludeUrls covered
    // every remaining URL. Frontend must NOT call completeSession here.
    const d = decideCompletion({ rowCount: 8546, errorCount: 0, listTotal: 32601, interrupted: false, retryableCount: 0 });
    expect(d.isStopped).toBe(true);
    expect(d.incompleteList).toBe(true);
    expect(d.hadFailures).toBe(false);
  });

  it("clean list-mode completion (rowCount === listTotal) is COMPLETE", () => {
    const d = decideCompletion({ rowCount: 50, errorCount: 0, listTotal: 50, interrupted: false, retryableCount: 0 });
    expect(d.isStopped).toBe(false);
    expect(d.incompleteList).toBe(false);
  });

  it("plain HTTP errors (404/403/timeout) do NOT mark a drained crawl STOPPED", () => {
    // The bug this fixes: a finished crawl with normal error rows was marked
    // stopped forever, so the UI invited endless resumes that exited at
    // processed:1. Errors are data, not interruption.
    const d = decideCompletion({ rowCount: 38371, errorCount: 125, listTotal: 0, interrupted: false, retryableCount: 0 });
    expect(d.isStopped).toBe(false);
    expect(d.hadFailures).toBe(true); // informational only
  });

  it("spider mode (listTotal=0) clean run is COMPLETE", () => {
    const d = decideCompletion({ rowCount: 3, errorCount: 0, listTotal: 0, interrupted: false, retryableCount: 0 });
    expect(d.isStopped).toBe(false);
    expect(d.incompleteList).toBe(false);
  });

  it("user-interrupted crawl is STOPPED (resumable) regardless of errors", () => {
    const d = decideCompletion({ rowCount: 100, errorCount: 0, listTotal: 0, interrupted: true, retryableCount: 0 });
    expect(d.isStopped).toBe(true);
  });

  it("remaining parked/blocked URLs mark STOPPED so they can be retried", () => {
    const d = decideCompletion({ rowCount: 5000, errorCount: 40, listTotal: 0, interrupted: false, retryableCount: 1786 });
    expect(d.isStopped).toBe(true);
  });
});
