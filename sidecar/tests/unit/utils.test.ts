import { describe, it, expect } from "vitest";
import { classifyResource } from "../../src/utils.js";

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
