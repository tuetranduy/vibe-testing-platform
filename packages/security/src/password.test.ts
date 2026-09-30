import { describe, expect, it } from "vitest";
import { hashPassword, newSessionToken, sessionTokenHash, verifyPassword } from "./password";

// Small work factors keep the suite fast; production uses the defaults.
const FAST = { N: 1024 };

describe("hashPassword / verifyPassword", () => {
  it("verifies the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery", FAST);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse battery ", hash)).toBe(false);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("stores the parameters and a random salt, never the password", async () => {
    const a = await hashPassword("correct horse battery", FAST);
    const b = await hashPassword("correct horse battery", FAST);
    expect(a).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("horse");
  });

  it("uses N=2^15 by default", async () => {
    expect(await hashPassword("correct horse battery")).toMatch(/^scrypt\$32768\$8\$1\$/);
  });

  it.each(["", "plain", "scrypt$1024$8$1$abc", "scrypt$x$8$1$AAAA$AAAA", "bcrypt$10$abc"])(
    "rejects a malformed stored hash %j",
    async (stored) => {
      expect(await verifyPassword("anything", stored)).toBe(false);
    },
  );

  it("verifies against the dummy hash in constant work (null → false)", async () => {
    expect(await verifyPassword("anything", null)).toBe(false);
  });
});

describe("session tokens", () => {
  it("are 32 random bytes in base64url, and hash to 32 bytes", () => {
    const t = newSessionToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSessionToken()).not.toBe(t);
    const h = sessionTokenHash(t);
    expect(h).toHaveLength(32);
    expect(sessionTokenHash(t).equals(h)).toBe(true);
  });
});
