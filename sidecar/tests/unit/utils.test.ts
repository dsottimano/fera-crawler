import { describe, it, expect } from "vitest";
import { classifyResource, readResponseCapped } from "../../src/utils.js";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("readResponseCapped", () => {
  it("returns the full body when under the cap (stream path)", async () => {
    const res = { body: streamOf([enc("hello "), enc("world")]), arrayBuffer: async () => new ArrayBuffer(0) };
    const { bytes, truncated } = await readResponseCapped(res, 1000);
    expect(dec(bytes)).toBe("hello world");
    expect(truncated).toBe(false);
  });

  it("stops at the cap and flags truncated (stream path)", async () => {
    const res = { body: streamOf([enc("aaaa"), enc("bbbb"), enc("cccc")]), arrayBuffer: async () => new ArrayBuffer(0) };
    const { bytes, truncated } = await readResponseCapped(res, 6);
    expect(bytes.length).toBe(6);
    expect(dec(bytes)).toBe("aaaabb");
    expect(truncated).toBe(true);
  });

  it("falls back to arrayBuffer + trims when there is no stream", async () => {
    const full = enc("0123456789");
    const res = { body: null, arrayBuffer: async () => full.buffer.slice(0, full.length) };
    const under = await readResponseCapped(res, 100);
    expect(dec(under.bytes)).toBe("0123456789");
    expect(under.truncated).toBe(false);
    const over = await readResponseCapped(res, 4);
    expect(over.bytes.length).toBe(4);
    expect(over.truncated).toBe(true);
  });
});

describe("classifyResource", () => {
  it("classifies text/html as HTML", () => {
    expect(classifyResource("text/html")).toBe("HTML");
    expect(classifyResource("text/html; charset=utf-8")).toBe("HTML");
  });

  it("classifies application/xhtml+xml as HTML", () => {
    expect(classifyResource("application/xhtml+xml")).toBe("HTML");
  });

  it("classifies text/css as CSS", () => {
    expect(classifyResource("text/css")).toBe("CSS");
    expect(classifyResource("text/css; charset=utf-8")).toBe("CSS");
  });

  it("classifies JavaScript content types", () => {
    expect(classifyResource("application/javascript")).toBe("JavaScript");
    expect(classifyResource("text/javascript")).toBe("JavaScript");
    expect(classifyResource("application/ecmascript")).toBe("JavaScript");
  });

  it("classifies image types", () => {
    expect(classifyResource("image/png")).toBe("Image");
    expect(classifyResource("image/jpeg")).toBe("Image");
    expect(classifyResource("image/gif")).toBe("Image");
    expect(classifyResource("image/svg+xml")).toBe("Image");
    expect(classifyResource("image/webp")).toBe("Image");
  });

  it("classifies font types", () => {
    expect(classifyResource("font/woff")).toBe("Font");
    expect(classifyResource("font/woff2")).toBe("Font");
    expect(classifyResource("font/ttf")).toBe("Font");
    expect(classifyResource("application/font-woff")).toBe("Font");
    expect(classifyResource("application/x-font-opentype")).toBe("Font");
  });

  it("classifies application/pdf as PDF", () => {
    expect(classifyResource("application/pdf")).toBe("PDF");
  });

  it("classifies unknown types as Other", () => {
    expect(classifyResource("application/json")).toBe("Other");
    expect(classifyResource("text/plain")).toBe("Other");
    expect(classifyResource("application/xml")).toBe("Other");
    expect(classifyResource("")).toBe("Other");
  });

  it("is case-insensitive", () => {
    expect(classifyResource("Text/HTML")).toBe("HTML");
    expect(classifyResource("IMAGE/PNG")).toBe("Image");
    expect(classifyResource("Application/PDF")).toBe("PDF");
  });
});
