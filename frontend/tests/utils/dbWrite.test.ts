import { describe, it, expect } from "vitest";
import { serializeWrite } from "../../src/utils/dbWrite";

describe("serializeWrite", () => {
  it("runs writes one at a time, in submission order", async () => {
    const order: string[] = [];
    const a = serializeWrite(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("a");
    });
    const b = serializeWrite(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("b");
    });
    const c = serializeWrite(async () => {
      order.push("c");
    });
    await Promise.all([a, b, c]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("returns the op's resolved value", async () => {
    const result = await serializeWrite(async () => 42);
    expect(result).toBe(42);
  });

  it("rejected write does not poison the chain (next write still runs)", async () => {
    const a = serializeWrite(async () => {
      throw new Error("boom");
    });
    let bRan = false;
    const b = serializeWrite(async () => {
      bRan = true;
      return "ok";
    });
    await expect(a).rejects.toThrow("boom");
    await expect(b).resolves.toBe("ok");
    expect(bRan).toBe(true);
  });

  it("retries on SQLITE_BUSY then succeeds", async () => {
    let attempts = 0;
    const result = await serializeWrite(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("error returned from database: (code: 5) database is locked");
      }
      return "won";
    });
    expect(result).toBe("won");
    expect(attempts).toBe(3);
  });

  it("non-busy errors fail fast (no retry)", async () => {
    let attempts = 0;
    await expect(
      serializeWrite(async () => {
        attempts += 1;
        throw new Error("syntax error near 'fro'");
      })
    ).rejects.toThrow("syntax error");
    expect(attempts).toBe(1);
  });

  it("gives up after 5 busy retries", async () => {
    let attempts = 0;
    await expect(
      serializeWrite(async () => {
        attempts += 1;
        throw new Error("(code: 5) database is locked");
      })
    ).rejects.toThrow("database is locked");
    expect(attempts).toBe(5);
  });
});
