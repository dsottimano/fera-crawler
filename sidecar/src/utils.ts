import type { ResourceType } from "./types.js";

// Read a fetch Response body but never buffer more than `maxBytes` in memory.
// Untrusted remote documents (robots.txt, sitemaps) have no inherent size
// limit; a hostile or misconfigured origin could otherwise stream hundreds of
// MB into the Node heap via res.text()/arrayBuffer(). Reads the stream chunk by
// chunk, stops at the cap, and cancels the rest. `truncated` signals the cap
// was hit so callers can decide whether the partial body is usable.
export async function readResponseCapped(
  res: { body: ReadableStream<Uint8Array> | null; arrayBuffer(): Promise<ArrayBuffer> },
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    // No stream (e.g. a mocked Response) — fall back and post-trim.
    const full = new Uint8Array(await res.arrayBuffer());
    return full.length > maxBytes
      ? { bytes: full.subarray(0, maxBytes), truncated: true }
      : { bytes: full, truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = maxBytes - total;
    if (value.length >= remaining) {
      chunks.push(value.subarray(0, remaining));
      total += remaining;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return { bytes: out, truncated };
}

export function classifyResource(contentType: string): ResourceType {
  const ct = contentType.toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/xhtml")) return "HTML";
  if (ct.includes("text/css")) return "CSS";
  if (ct.includes("javascript") || ct.includes("ecmascript")) return "JavaScript";
  if (ct.includes("image/")) return "Image";
  if (ct.includes("font/") || ct.includes("application/font") || ct.includes("woff") || ct.includes("opentype")) return "Font";
  if (ct.includes("application/pdf")) return "PDF";
  return "Other";
}
