import { describe, it, expect } from "vitest";
import {
  buildStealthInitScript,
  generateFingerprint,
  fingerprintDigest,
  resolvePatches,
  DEFAULT_STEALTH_PATCHES,
  buildHeaders,
  buildUserAgent,
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

  it("bakes canvasNoise and matchMedia patches by default", () => {
    const script = buildStealthInitScript({ seed: "x" });
    expect(script).toContain("patchCanvas");
    expect(script).toContain("patchMatchMedia");
    expect(script).toContain("prefers-color-scheme");
    expect(script).toContain("canvasSeed");
  });
});

describe("patch gating", () => {
  it("DEFAULT_STEALTH_PATCHES is all true", () => {
    for (const v of Object.values(DEFAULT_STEALTH_PATCHES)) {
      expect(v).toBe(true);
    }
  });

  it("resolvePatches merges partial over defaults", () => {
    const merged = resolvePatches({ canvasNoise: false });
    expect(merged.canvasNoise).toBe(false);
    expect(merged.webdriver).toBe(true);
    expect(merged.matchMedia).toBe(true);
  });

  it("disabling canvasNoise stops the patchCanvas IIFE from running", () => {
    // Patch body is gated at runtime on P.canvasNoise, so the function-body
    // string still appears, but the config blob inside the script is
    // "canvasNoise":false which the gate reads.
    const script = buildStealthInitScript({ seed: "y", patches: { canvasNoise: false } });
    expect(script).toContain('"canvasNoise":false');
    expect(script).toContain('"webdriver":true');
  });

  it("disabling matchMedia reflects in baked config blob", () => {
    const script = buildStealthInitScript({ seed: "z", patches: { matchMedia: false } });
    expect(script).toContain('"matchMedia":false');
  });

  it("disabling nativeToString reflects in baked config blob", () => {
    const script = buildStealthInitScript({ seed: "n", patches: { nativeToString: false } });
    expect(script).toContain('"nativeToString":false');
  });

  it("partial patches leave unspecified toggles at their defaults", () => {
    const script = buildStealthInitScript({ seed: "q", patches: { canvasNoise: false, matchMedia: false } });
    expect(script).toContain('"canvasNoise":false');
    expect(script).toContain('"matchMedia":false');
    expect(script).toContain('"webdriver":true');
    expect(script).toContain('"userAgentData":true');
  });
});

describe("buildHeaders", () => {
  it("User-Agent matches fingerprint platform and Chrome version", () => {
    const fp = generateFingerprint({ seed: "ua-test", platform: "Windows" });
    const ua = buildUserAgent(fp);
    expect(ua).toContain("Windows NT 10.0; Win64; x64");
    expect(ua).toContain(`Chrome/${fp.chromeFullVersion}`);
  });

  it("macOS UA uses frozen 10_15_7 string", () => {
    const fp = generateFingerprint({ seed: 1, platform: "macOS" });
    expect(buildUserAgent(fp)).toContain("Mac OS X 10_15_7");
  });

  it("Linux UA uses X11 Linux x86_64", () => {
    const fp = generateFingerprint({ seed: 1, platform: "Linux" });
    expect(buildUserAgent(fp)).toContain("X11; Linux x86_64");
  });

  it("Sec-CH-UA-Platform matches fingerprint platform", () => {
    const winFp = generateFingerprint({ seed: 1, platform: "Windows" });
    expect(buildHeaders(winFp)["Sec-CH-UA-Platform"]).toBe('"Windows"');
    const macFp = generateFingerprint({ seed: 1, platform: "macOS" });
    expect(buildHeaders(macFp)["Sec-CH-UA-Platform"]).toBe('"macOS"');
    const linFp = generateFingerprint({ seed: 1, platform: "Linux" });
    expect(buildHeaders(linFp)["Sec-CH-UA-Platform"]).toBe('"Linux"');
  });

  it("Sec-CH-UA brands list includes Chromium and Google Chrome with correct major", () => {
    const fp = generateFingerprint({ seed: "ch-ua" });
    const h = buildHeaders(fp);
    expect(h["Sec-CH-UA"]).toContain(`"Chromium";v="${fp.chromeMajor}"`);
    expect(h["Sec-CH-UA"]).toContain(`"Google Chrome";v="${fp.chromeMajor}"`);
    expect(h["Sec-CH-UA-Mobile"]).toBe("?0");
  });

  it("Accept-Language uses first fingerprint language", () => {
    const fp = generateFingerprint({ seed: "lang" });
    const h = buildHeaders(fp);
    expect(h["Accept-Language"]).toContain(fp.languages[0]);
  });

  it("headers and init script are identity-consistent (both built from same fp)", () => {
    const fp = generateFingerprint({ seed: "identity" });
    const headers = buildHeaders(fp);
    const script = buildStealthInitScript({ seed: "identity" });
    // UA-CH platform in the script's baked FP must match the Sec-CH-UA-Platform header.
    expect(script).toContain(`"uaPlatform":"${fp.uaPlatform}"`);
    expect(headers["Sec-CH-UA-Platform"]).toBe(`"${fp.uaPlatform}"`);
  });
});
