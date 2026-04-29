// Brand + domain vocabulary for STT post-correction.
//
// Whisper has no idea "Fera" is a word — it transcribes whatever phonetic
// neighbor the language model finds most likely. Fix that with two layers:
//
//   1. PROMPT_TEXT is fed to the decoder as initial context (biases the model
//      toward producing these words in the first place).
//   2. CORRECTIONS rewrites known mishearings post-transcription (catches
//      whatever still slips through).
//
// Grow this list as new mishearings appear — both layers benefit.

export const PROMPT_TEXT =
  "Fera, an SEO crawler. Patchright. Probe, crawl, recrawl, sidecar, Tauri, Vue, sitemap, robots.";

export interface VocabularyEntry {
  canonical: string;
  aliases: string[];
}

export const CORRECTIONS: VocabularyEntry[] = [
  {
    canonical: "Fera",
    aliases: [
      "farah", "farrah", "fara", "fira", "ferra", "ferro", "feral",
      "faro", "vera", "pharaoh", "ferret",
    ],
  },
  {
    canonical: "Patchright",
    aliases: ["patch right", "patchwright", "patch write", "pat right"],
  },
];

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

export function applyVocabularyCorrections(text: string): string {
  if (!text) return text;
  let out = text;
  for (const entry of CORRECTIONS) {
    for (const alias of entry.aliases) {
      // Allow flexible whitespace inside multi-word aliases ("patch right").
      const pattern = alias
        .split(/\s+/)
        .map((w) => w.replace(ESCAPE_RE, "\\$&"))
        .join("\\s+");
      const re = new RegExp(`\\b${pattern}\\b`, "gi");
      out = out.replace(re, entry.canonical);
    }
  }
  return out;
}

// Normalize voice-style transcripts before sending to Claude:
//   "example dot com"     → "example.com"
//   "fera dot crawler"    → "fera.crawler"
//   "slash docs slash X"  → "/docs/X"
//   "https colon slash slash example dot com" → "https://example.com"
//   trailing/leading periods, double spaces collapsed.
//
// Without this, Claude reads voice URLs as English phrases and refuses to
// crawl them.
const TLDS = [
  "com", "org", "net", "io", "co", "ai", "dev", "app", "uk", "us", "ca",
  "de", "fr", "es", "jp", "au", "edu", "gov", "info", "biz", "me", "tv",
  "xyz", "tech", "site", "online", "store",
];

export function normalizeVoiceTranscript(text: string): string {
  if (!text) return text;
  let out = text;

  // "https colon slash slash" / "http colon slash slash"
  out = out.replace(/\bhttps?\s+colon\s+slash\s+slash\s+/gi, (m) =>
    m.toLowerCase().startsWith("https") ? "https://" : "http://"
  );

  // "X dot <tld>" — collapse to "X.<tld>" (only for known TLDs to avoid
  // mangling phrases like "the dot com era").
  for (const tld of TLDS) {
    const re = new RegExp(`\\b([\\w-]+)\\s+dot\\s+${tld}\\b`, "gi");
    out = out.replace(re, `$1.${tld}`);
  }

  // "slash word" → "/word" (paths)
  out = out.replace(/\s+slash\s+/gi, "/");

  // "dash" → "-" inside what looks like a URL fragment
  out = out.replace(/(\w)\s+dash\s+(\w)/gi, "$1-$2");

  // Collapse runs of spaces / strip trailing periods that Whisper adds.
  out = out.replace(/\s{2,}/g, " ").replace(/\.\s*$/, "").trim();

  return out;
}
