import { afterEach, describe, expect, it, vi } from "vitest";
import { newIdempotencyKey } from "./uuid";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.unstubAllGlobals());

describe("newIdempotencyKey", () => {
  it("uses crypto.randomUUID when available", () => {
    expect(newIdempotencyKey()).toMatch(V4);
  });

  it("falls back to getRandomValues outside a secure context (no randomUUID)", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    expect(globalThis.crypto.randomUUID).toBeUndefined();
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).toMatch(V4);
    expect(b).toMatch(V4);
    expect(a).not.toBe(b);
  });
});
