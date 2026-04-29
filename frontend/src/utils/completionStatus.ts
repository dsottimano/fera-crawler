// Decides whether a "crawl-complete" event from the sidecar represents a real
// completion or a stopped state. Two ways to be stopped:
//   1. Any row failed (HTTP 4xx/5xx, status 0, or non-empty error string).
//   2. List-mode coverage gap — fewer rows in the DB than the queued list.
//      Happens when the sidecar emits complete after a resume that skipped
//      everything via excludeUrls (no new work to do, but the original list
//      was never finished).
//
// Phase-6 contract: the inputs are aggregate counts (no in-memory rows).
// Caller fetches them from aggregate_health + crawlProgress; this function
// is pure logic so it stays unit-testable independent of either.
export interface CompletionDecision {
  isStopped: boolean;
  hadFailures: boolean;
  incompleteList: boolean;
}

export function decideCompletion(args: {
  rowCount: number;
  errorCount: number;
  listTotal: number;
}): CompletionDecision {
  const hadFailures = args.errorCount > 0;
  const incompleteList = args.listTotal > 0 && args.rowCount < args.listTotal;
  return {
    isStopped: hadFailures || incompleteList,
    hadFailures,
    incompleteList,
  };
}
