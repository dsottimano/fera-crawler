import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri invoke entry point used by flushPendingInserts. We do NOT
// mock @tauri-apps/plugin-sql here — that module is already lazy-loaded by
// useDatabase via Database.load(); since flushPendingInserts no longer
// touches the SQL plugin (Rust owns the writes after Phase 1), the test
// can drive the function purely through the invoke mock.
//
// vi.mock() factories run before module imports — vi.hoisted hoists shared
// state to the same phase so the factory can reference it.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// Stub plugin-sql so the surrounding module imports don't fail during test
// setup (no Tauri runtime available in vitest).
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: vi.fn(async () => ({ execute: vi.fn(), select: vi.fn() })) },
}));

import { flushPendingInserts } from "../../src/composables/useDatabase";

describe("flushPendingInserts", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes the Rust flush_crawl_writes command", async () => {
    invokeMock.mockResolvedValue(undefined);
    await flushPendingInserts();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("flush_crawl_writes");
  });

  it("swallows errors from the Rust command (readers should still get on-disk rows)", async () => {
    invokeMock.mockRejectedValue(new Error("simulated writer failure"));
    // No throw — the function logs and returns.
    await expect(flushPendingInserts()).resolves.toBeUndefined();
  });
});
