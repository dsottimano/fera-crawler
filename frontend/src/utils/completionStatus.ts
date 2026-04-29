import type { CrawlResult } from "../types/crawl";

// Decides whether a "crawl-complete" event from the sidecar represents a real
// completion or a stopped state. Two ways to be stopped:
//   1. Any result has an error / 4xx-5xx / network failure.
//   2. List-mode coverage gap — we received fewer rows than the queued list.
//      Happens when the sidecar emits complete after a resume that skipped
//      everything via excludeUrls (no new work to do, but the original list
//      was never finished).
export interface CompletionDecision {
  isStopped: boolean;
  hadFailures: boolean;
  incompleteList: boolean;
}

export function decideCompletion(args: {
  results: CrawlResult[];
  listTotal: number;
}): CompletionDecision {
  const hadFailures = args.results.some(
    (r) => r.status >= 400 || r.status === 0 || !!r.error
  );
  const incompleteList = args.listTotal > 0 && args.results.length < args.listTotal;
  return {
    isStopped: hadFailures || incompleteList,
    hadFailures,
    incompleteList,
  };
}
