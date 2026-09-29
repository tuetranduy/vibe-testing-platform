import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { containsFingerprintedSecret, redactFingerprintedSecrets, secretFingerprint } from "./secret-fingerprint";

const key = randomBytes(32);
const fp = (v: string) => secretFingerprint(v, key);

describe("secret fingerprints", () => {
  it("masks every occurrence of a secret value without knowing it", () => {
    const fps = [fp("hunter2-long")];
    expect(redactFingerprintedSecrets("log in with hunter2-long, then hunter2-long again", fps, key)).toBe(
      "log in with [REDACTED], then [REDACTED] again",
    );
    expect(containsFingerprintedSecret("typed hunter2-long", fps, key)).toBe(true);
  });

  it("handles several secrets, overlapping values and non-ASCII text", () => {
    const fps = [fp("pässwört-1"), fp("abcd"), fp("abcdef")];
    expect(redactFingerprintedSecrets("é pässwört-1 é abcdefg", fps, key)).toBe("é [REDACTED] é [REDACTED]g");
  });

  it("leaves text without the value (or a near miss) unchanged", () => {
    const fps = [fp("hunter2-long")];
    expect(redactFingerprintedSecrets("hunter2-lon and Hunter2-long", fps, key)).toBe("hunter2-lon and Hunter2-long");
    expect(containsFingerprintedSecret("nothing here", fps, key)).toBe(false);
    expect(containsFingerprintedSecret("anything", [], key)).toBe(false);
  });

  it("depends on the key: another key's fingerprint never matches", () => {
    expect(containsFingerprintedSecret("hunter2-long", [secretFingerprint("hunter2-long", randomBytes(32))], key)).toBe(false);
  });

  it("scans a 20,000-character requirement with ten secrets quickly", () => {
    const fps = Array.from({ length: 10 }, (_, i) => fp(`secret-value-${i}-${"x".repeat(i)}`));
    const text = "a".repeat(19_980) + "secret-value-3-xxx";
    const started = performance.now();
    expect(redactFingerprintedSecrets(text, fps, key).endsWith("[REDACTED]")).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
