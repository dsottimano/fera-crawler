import { describe, it, expect } from "vitest";
import {
  buildStealthInitScript,
  generateFingerprint,
  fingerprintDigest,
} from "../../src/stealth.js";

describe("generateFingerprint", () => {
  it("same seed produces identical fingerprint", () => {
    const a = generateFingerprint({ seed: "https://example.com/" });
    const b = generateFingerprint({ seed: "https://example.com/" });
    expect(a).toEqual(b);
  });

  it("different seeds produce different digests", () => {
    const a = fingerprintDigest(generateFingerprint({ seed: "host-a" }));
    const b = fingerprintDigest(generateFingerprint({ seed: "host-b" }));
    expect(a).not.toEqual(b);
  });

  it("platform override is honored", () => {
    const fp = generateFingerprint({ seed: 42, platform: "macOS" });
    expect(fp.platform).toBe("macOS");
    expect(fp.navigatorPlatform).toBe("MacIntel");
    expect(fp.uaPlatform).toBe("macOS");
  });

  it("Windows maps to Win32 navigator.platform", () => {
    const fp = generateFingerprint({ seed: 1, platform: "Windows" });
    expect(fp.navigatorPlatform).toBe("Win32");
  });

  it("Linux maps to Linux x86_64 navigator.platform", () => {
    const fp = generateFingerprint({ seed: 1, platform: "Linux" });
    expect(fp.navigatorPlatform).toBe("Linux x86_64");
  });

  it("values are plausible", () => {
    const fp = generateFingerprint({ seed: 1234 });
    expect([4, 8, 12, 16]).toContain(fp.hardwareConcurrency);
    expect([4, 8, 16]).toContain(fp.deviceMemory);
    expect(fp.screenWidth).toBeGreaterThan(1000);
    expect(fp.screenHeight).toBeGreaterThan(600);
    expect(fp.availHeight).toBeLessThan(fp.screenHeight);
    expect(fp.chromeMajor).toBeGreaterThanOrEqual(143);
    expect(fp.chromeFullVersion).toMatch(/^\d+\.0\.\d+\.\d+$/);
    expect(fp.languages[0]).toBe("en-US");
  });
});

describe("buildStealthInitScript", () => {
  it("produces non-empty IIFE", () => {
    const script = buildStealthInitScript({ seed: "seed" });
    expect(script).toMatch(/^\(\(\) => \{/);
    expect(script).toMatch(/\}\)\(\);$/);
    expect(script.length).toBeGreaterThan(2000);
  });

  it("bakes the fingerprint into the script", () => {
    const fp = generateFingerprint({ seed: "seed" });
    const script = buildStealthInitScript({ seed: "seed" });
    expect(script).toContain(fp.navigatorPlatform);
    expect(script).toContain(fp.webglVendor);
    expect(script).toContain(fp.chromeFullVersion);
  });

  it("installs key patches referenced in the source", () => {
    const script = buildStealthInitScript({ seed: 1 });
    // Patch markers that must be present for the stealth set to function.
    expect(script).toContain("get webdriver");
    expect(script).toContain("plugins");
    expect(script).toContain("userAgentData");
    expect(script).toContain("WebGLRenderingContext");
    expect(script).toContain("Function.prototype.toString");
    expect(script).toContain("isTrusted");
    expect(script).toContain("window.chrome");
  });

  it("is deterministic for identical opts", () => {
    const a = buildStealthInitScript({ seed: "abc" });
    const b = buildStealthInitScript({ seed: "abc" });
    expect(a).toBe(b);
  });
});
