// Pasted text → URL list. Splits on whitespace + commas, trims, drops
// anything without an http(s):// prefix.
//
// Used by the URL bar's auto-list-mode detection: pasting 2+ URLs flips
// the toolbar into list mode and seeds inputs.urls. Pure function so
// the parsing rules are unit-testable independent of the clipboard
// event plumbing.
export function extractPastedUrls(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}
