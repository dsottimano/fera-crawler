// Pure helpers for the comma-formatted numeric input. Extracted from
// NumberInput.vue so the parse/clamp/format logic can be unit-tested without
// mounting Vue.

export interface ClampOpts {
  min?: number;
  max?: number;
}

export function clamp(n: number, opts: ClampOpts): number {
  let c = n;
  if (opts.min !== undefined) c = Math.max(opts.min, c);
  if (opts.max !== undefined) c = Math.min(opts.max, c);
  return c;
}

// Strips non-numeric characters, then parses. Used for display draft → model
// value conversion. Returns null when the string can't be a number yet
// (empty, "-" alone) so callers can hold off on emitting.
export function parseNumericDraft(raw: string): number | null {
  const cleaned = raw.replace(/[^\d,-]/g, "").replace(/,/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n;
}

// Final blur handler: parses, clamps, and falls back to the last-good value
// if the user typed garbage.
export function commitNumericDraft(
  raw: string,
  lastGood: number,
  opts: ClampOpts,
): number {
  const parsed = parseNumericDraft(raw);
  if (parsed === null) return lastGood;
  return clamp(parsed, opts);
}

const FORMATTER = new Intl.NumberFormat("en-US");

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "";
  return FORMATTER.format(n);
}
