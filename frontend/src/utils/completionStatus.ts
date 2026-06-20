// Decides whether a "crawl-complete" event from the sidecar represents a real
// completion or a stopped (resumable) state. A crawl is stopped if:
//   1. The user explicitly stopped it (interrupted) — the sidecar was killed
//      mid-queue, so there is almost certainly uncrawled work left.
//   2. List-mode coverage gap — fewer rows in the DB than the queued list.
//      Happens when the sidecar emits complete after a resume that skipped
//      everything via excludeUrls (no new work to do, but the original list
//      was never finished).
//   3. Parked/blocked URLs remain (retryableCount > 0) — the block detector
//      gated some hosts; those rows are placeholders, resumable on retry.
//
// NOTE: a non-empty error count is NOT a stopped signal. Normal crawls of any
// large site return 404s/403s/timeouts — that's data, not interruption. The
// old logic treated ANY error row as "stopped", so a finished crawl with a
// single 404 could never reach "complete" and the UI invited endless resumes
// that re-crawled the homepage and exited (processed:1). `hadFailures` is kept
// as an informational flag only.
//
// Inputs are aggregate counts (no in-memory rows); caller fetches them from
// aggregate_health + get_retryable_urls. Pure logic so it stays unit-testable.
export interface CompletionDecision {
  isStopped: boolean;
  hadFailures: boolean;
  incompleteList: boolean;
}

export function decideCompletion(args: {
  rowCount: number;
  errorCount: number;
  listTotal: number;
  interrupted: boolean;
  retryableCount: number;
}): CompletionDecision {
  const hadFailures = args.errorCount > 0;
  const incompleteList = args.listTotal > 0 && args.rowCount < args.listTotal;
  return {
    isStopped: args.interrupted || incompleteList || args.retryableCount > 0,
    hadFailures,
    incompleteList,
  };
}
