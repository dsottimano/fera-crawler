// Pasted content → URL list. Regex-scans for http(s) URLs anywhere in the
// string and dedupes. Works on plain text (newline/comma/whitespace lists)
// AND HTML (spreadsheet-copied tables, where the clipboard only carries
// text/html and each URL appears inside <td>…</td> or href="…").
//
// Used by the URL bar's auto-list-mode detection: pasting 2+ URLs flips
// the toolbar into list mode and seeds inputs.urls. Pure function so
// the parsing rules are unit-testable independent of the clipboard
// event plumbing.
export function extractPastedUrls(text: string): string[] {
  // URL char set: stop at whitespace, angle brackets, quotes, comma,
  // semicolon, backslash. Keeps `?`, `&`, `=`, `#`, `/` intact so paths
  // and query strings survive. Trailing punctuation in prose (`.`, `)`)
  // is rare in copied URL lists — accept the trade-off rather than
  // truncating real URL paths that legitimately end in those chars.
  const matches = text.match(/https?:\/\/[^\s<>"',;\\]+/gi) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}
