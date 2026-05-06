import { BlockDetector } from "./blockDetector.js";

export type Classification =
  | "ok"
  | "blocked-status:403"
  | "blocked-status:429"
  | "blocked-status:503"
  | "blocked-content"
  | "cloaked"
  | "other";

export interface ResponseSnapshot {
  url: string;
  status: number;
  title: string;
  bodyBytes: number;
  internalLinks: number;
}

export interface CloakBaseline {
  medianBodyBytes: number;
  medianInternalLinks: number;
}

const CLOAK_RATIO = 0.05;

export function classifyResponse(
  resp: ResponseSnapshot,
  host: string,
  detector: BlockDetector,
  baseline: CloakBaseline | null,
): Classification {
  if (resp.status === 403) return "blocked-status:403";
  if (resp.status === 429) return "blocked-status:429";
  if (resp.status === 503) return "blocked-status:503";

  const verdict = detector.classify({ url: resp.url, status: resp.status, title: resp.title }, host);
  if (verdict.blocked) {
    if (verdict.reason === "status_5xx") return "blocked-status:503";
    return "blocked-content";
  }

  if (resp.status < 200 || resp.status >= 300) return "other";

  if (
    baseline &&
    resp.bodyBytes < baseline.medianBodyBytes * CLOAK_RATIO &&
    resp.internalLinks < baseline.medianInternalLinks * CLOAK_RATIO
  ) {
    return "cloaked";
  }

  return "ok";
}
