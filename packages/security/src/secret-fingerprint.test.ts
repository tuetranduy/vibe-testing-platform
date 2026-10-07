import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { secretFingerprint } from "./secret-fingerprint";

const key = randomBytes(32);

describe("secretFingerprint", () => {
  it("is an HMAC of the value under the key, with its UTF-8 length", () => {
    const a = secretFingerprint("pässwört-1", key);
    expect(a.bytes).toBe(Buffer.byteLength("pässwört-1", "utf8"));
    expect(a.digest.equals(secretFingerprint("pässwört-1", key).digest)).toBe(true);
    expect(a.digest.equals(secretFingerprint("pässwört-1", randomBytes(32)).digest)).toBe(false);
  });
});
