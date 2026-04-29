import type { SettingsValues } from "../settings/types";

// The Tauri IPC payload sent to the `start_crawl` Rust command. Pure shape —
// extracted so the build logic can be unit-tested independent of the runtime.
// Field names match the camelCase keys the command expects (auto-converted to
// snake_case on the Rust side via serde rename_all). Index signature on
// the type so it matches Tauri's InvokeArgs constraint.
export interface StartCrawlPayload {
  url: string;
  // The DB session id this crawl writes rows to. Rust uses it to attribute
  // crawl-result NDJSON lines to the right session in the background writer.
  sessionId: number;
  maxRequests: number;
  concurrency: number;
  userAgent: string | null;
  respectRobots: boolean;
  delay: number;
  customHeaders: string | null;
  mode: "spider" | "list";
  urls: string[] | null;
  headless: boolean;
  downloadOgImage: boolean | null;
  scraperRules: string | null;
  stealthConfig: string;
  perHostDelay: number;
  perHostDelayMax: number;
  perHostConcurrency: number;
  sessionWarmup: boolean | null;
  excludeUrls: string[] | null;
  [k: string]: unknown;
}

export interface BuildPayloadOpts {
  mode?: "spider" | "list";
  urls?: string[];
  maxRequests?: number;
  excludeUrls?: Iterable<string>;
  // Required at call time but kept optional in the type so existing tests
  // that don't care about it can still build a valid payload (sessionId
  // defaults to 0, which Rust treats as "no session attached").
  sessionId?: number;
}

// Builds the start_crawl payload from a SettingsValues snapshot + per-call
// overrides. Ensures we never silently mix the default profile with a pinned
// crawl's settings: caller picks one source-of-truth and passes it in.
export function buildStartCrawlPayload(
  url: string,
  s: SettingsValues,
  opts: BuildPayloadOpts = {},
): StartCrawlPayload {
  const inputs = s.inputs;
  const { userAgent: stealthUa, ...stealthPatches } = s.stealth;
  const mode = opts.mode ?? s.crawling.mode;
  const urls = opts.urls ?? inputs.urls;
  const maxRequests = opts.maxRequests ?? s.crawling.maxRequests;
  const excludeUrlsArr = opts.excludeUrls ? Array.from(opts.excludeUrls) : [];

  return {
    url,
    sessionId: opts.sessionId ?? 0,
    maxRequests,
    concurrency: s.crawling.concurrency,
    userAgent: stealthUa || null,
    respectRobots: s.crawling.respectRobots,
    delay: s.crawling.delay,
    customHeaders: Object.keys(inputs.customHeaders).length
      ? JSON.stringify(inputs.customHeaders)
      : null,
    mode,
    urls: urls.length ? [...urls] : null,
    headless: s.authentication.headless,
    downloadOgImage: s.extraction.downloadOgImage || null,
    scraperRules: inputs.scraperRules.length
      ? JSON.stringify(inputs.scraperRules)
      : null,
    stealthConfig: JSON.stringify(stealthPatches),
    perHostDelay: s.performance.perHostDelay,
    perHostDelayMax: s.performance.perHostDelayMax,
    perHostConcurrency: s.performance.perHostConcurrency,
    sessionWarmup: s.performance.sessionWarmup || null,
    excludeUrls: excludeUrlsArr.length ? excludeUrlsArr : null,
  };
}
