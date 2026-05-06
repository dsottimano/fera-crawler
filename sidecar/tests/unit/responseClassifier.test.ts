import { describe, it, expect } from "vitest";
import { classifyResponse } from "../../src/responseClassifier.js";
import { BlockDetector } from "../../src/blockDetector.js";

describe("classifyResponse", () => {
  const detector = new BlockDetector();

  it("returns ok for clean 200 with no baseline", () => {
    const r = classifyResponse(
      { url: "https://h.com/p", status: 200, title: "Page", bodyBytes: 50000, internalLinks: 80 },
      "h.com",
      detector,
      null,
    );
    expect(r).toBe("ok");
  });

  it("returns blocked-status:403 for HTTP 403", () => {
    const r = classifyResponse(
      { url: "https://h.com/p", status: 403, title: "", bodyBytes: 0, internalLinks: 0 },
      "h.com",
      detector,
      null,
    );
    expect(r).toBe("blocked-status:403");
  });

  it("returns blocked-status:429 for HTTP 429", () => {
    const r = classifyResponse(
      { url: "https://h.com/p", status: 429, title: "", bodyBytes: 0, internalLinks: 0 },
      "h.com",
      detector,
      null,
    );
    expect(r).toBe("blocked-status:429");
  });

  it("returns blocked-status:503 for HTTP 503", () => {
    const r = classifyResponse(
      { url: "https://h.com/p", status: 503, title: "", bodyBytes: 0, internalLinks: 0 },
      "h.com",
      detector,
      null,
    );
    expect(r).toBe("blocked-status:503");
  });

  it("returns blocked-content for 200 with challenge title", () => {
    const r = classifyResponse(
      { url: "https://h.com/p", status: 200, title: "Just a moment...", bodyBytes: 1000, internalLinks: 0 },
      "h.com",
      detector,
      null,
    );
    expect(r).toBe("blocked-content");
  });

  it("returns cloaked when body and links both < 5% of baseline", () => {
    const baseline = { medianBodyBytes: 50000, medianInternalLinks: 80 };
    const r = classifyResponse(
      { url: "https://h.com/p", status: 200, title: "Page", bodyBytes: 1000, internalLinks: 2 },
      "h.com",
      detector,
      baseline,
    );
    expect(r).toBe("cloaked");
  });

  it("returns ok when only body is below cloak threshold (links normal)", () => {
    const baseline = { medianBodyBytes: 50000, medianInternalLinks: 80 };
    const r = classifyResponse(
      { url: "https://h.com/p", status: 200, title: "Page", bodyBytes: 1000, internalLinks: 80 },
      "h.com",
      detector,
      baseline,
    );
    expect(r).toBe("ok");
  });

  it("returns other for non-block 4xx (404)", () => {
    const r = classifyResponse(
      { url: "https://h.com/p", status: 404, title: "", bodyBytes: 0, internalLinks: 0 },
      "h.com",
      detector,
      null,
    );
    expect(r).toBe("other");
  });
});
