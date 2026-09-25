import { describe, expect, it } from "vitest";
import { REDACTED, createRunRedactor, createValueRedactor, isSensitiveKey, redactByKey } from "./redaction";

describe("redactByKey", () => {
  it("redacts the plan example", () => {
    expect(redactByKey({ authorization: "Bearer secret", password: "hello", email: "qa@example.com" })).toEqual({
      authorization: "[REDACTED]",
      password: "[REDACTED]",
      email: "qa@example.com",
    });
    expect(REDACTED).toBe("[REDACTED]");
  });

  it.each([
    "authorization",
    "cookie",
    "set-cookie",
    "password",
    "passwd",
    "secret",
    "token",
    "access_token",
    "refresh_token",
    "api_key",
    "apikey",
    "x-api-key",
    "session",
    "sessionid",
  ])("redacts listed key %s (any case)", (key) => {
    expect(redactByKey({ [key]: "v" })).toEqual({ [key]: REDACTED });
    expect(redactByKey({ [key.toUpperCase()]: "v" })).toEqual({ [key.toUpperCase()]: REDACTED });
  });

  it.each([
    "Authorization",
    "Set-Cookie",
    "X-API-Key",
    "accessToken",
    "refreshToken",
    "apiKey",
    "sessionId",
    "session_id",
    "csrfToken",
    "idToken",
    "auth_token",
    "clientSecret",
    "client_secret",
    "secretKey",
    "privateKey",
    "newPassword",
    "passwordConfirmation",
    "user_password",
    "db_passwd",
  ])("redacts variant %s", (key) => {
    expect(redactByKey({ [key]: "v" })).toEqual({ [key]: REDACTED });
  });

  it.each(["email", "username", "tokens", "maxTokens", "inputTokens", "tokenCount", "secretName", "sessions", "name"])(
    "does not redact %s",
    (key) => {
      expect(redactByKey({ [key]: "v" })).toEqual({ [key]: "v" });
    },
  );

  it("is deep and includes arrays", () => {
    const input = {
      request: {
        headers: [
          { name: "Cookie", value: "a=b" },
          { cookie: "sid=1", accept: "text/html" },
        ],
        nested: { deeper: { token: "t", ok: 1 } },
      },
      list: [[{ password: "p" }]],
    };
    expect(redactByKey(input)).toEqual({
      request: {
        headers: [
          { name: "Cookie", value: "a=b" },
          { cookie: REDACTED, accept: "text/html" },
        ],
        nested: { deeper: { token: REDACTED, ok: 1 } },
      },
      list: [[{ password: REDACTED }]],
    });
  });

  it("redacts non-string values under sensitive keys, keeps null/undefined", () => {
    expect(redactByKey({ token: { a: 1 }, secret: 42, password: null, apikey: undefined })).toEqual({
      token: REDACTED,
      secret: REDACTED,
      password: null,
      apikey: undefined,
    });
  });

  it("does not mutate the input", () => {
    const input = { password: "p", nested: { token: "t" }, arr: [{ secret: "s" }] };
    const snapshot = structuredClone(input);
    const out = redactByKey(input) as typeof input;
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
    expect(out.nested).not.toBe(input.nested);
  });

  it("passes primitives through", () => {
    expect(redactByKey("x")).toBe("x");
    expect(redactByKey(1)).toBe(1);
    expect(redactByKey(null)).toBe(null);
    expect(redactByKey(undefined)).toBe(undefined);
    expect(redactByKey(true)).toBe(true);
  });

  it("handles cycles without throwing and preserves the cycle shape", () => {
    const a: Record<string, unknown> = { password: "p", name: "a" };
    a.self = a;
    const arr: unknown[] = [];
    arr.push(arr);
    const out = redactByKey({ a, arr }) as { a: Record<string, unknown>; arr: unknown[] };
    expect(out.a.password).toBe(REDACTED);
    expect(out.a.self).toBe(out.a);
    expect(out.arr[0]).toBe(out.arr);
    expect(a.password).toBe("p");
  });

  it("keeps Dates and Buffers as-is", () => {
    const d = new Date("2026-01-01T00:00:00Z");
    const b = Buffer.from("raw");
    const out = redactByKey({ at: d, blob: b }) as { at: Date; blob: Buffer };
    expect(out.at).toBe(d);
    expect(out.blob).toBe(b);
  });

  it("walks Maps and Sets", () => {
    const out = redactByKey({
      m: new Map<unknown, unknown>([
        ["password", "p"],
        ["ok", { token: "t" }],
      ]),
      s: new Set([{ secret: "s" }]),
    }) as { m: Map<string, unknown>; s: Set<unknown> };
    expect(out.m.get("password")).toBe(REDACTED);
    expect(out.m.get("ok")).toEqual({ token: REDACTED });
    expect([...out.s]).toEqual([{ secret: REDACTED }]);
  });

  it("isSensitiveKey is exported", () => {
    expect(isSensitiveKey("X-Api-Key")).toBe(true);
    expect(isSensitiveKey("email")).toBe(false);
  });
});

describe("createValueRedactor", () => {
  it("redacts a secret inside a string (plan example)", () => {
    const redact = createValueRedactor(["hunter2-long"]);
    expect(redact("typed hunter2-long into field")).toBe("typed [REDACTED] into field");
  });

  it("redacts every occurrence", () => {
    const redact = createValueRedactor(["s3cr3t!"]);
    expect(redact("s3cr3t! and s3cr3t!s3cr3t!")).toBe("[REDACTED] and [REDACTED][REDACTED]");
  });

  it("redacts the URL-encoded form (either hex case) and the form-encoded form", () => {
    const secret = "p@ss w/rd&x=1";
    const redact = createValueRedactor([secret]);
    const enc = encodeURIComponent(secret);
    expect(redact(`https://x.test/login?pw=${enc}&ok=1`)).toBe("https://x.test/login?pw=[REDACTED]&ok=1");
    expect(redact(`pw=${enc.toLowerCase()}`)).toBe("pw=[REDACTED]");
    const form = new URLSearchParams({ pw: secret }).toString(); // spaces as '+'
    expect(redact(form)).toBe("pw=[REDACTED]");
  });

  it("redacts standard and url-safe base64 forms, padded or not", () => {
    const secret = "hunter2-long??>"; // produces '+' / '/' in std base64
    const redact = createValueRedactor([secret]);
    const std = Buffer.from(secret).toString("base64");
    const url = Buffer.from(secret).toString("base64url");
    expect(std).not.toBe(url);
    expect(redact(`data ${std} end`)).toBe("data [REDACTED] end");
    expect(redact(`data ${url} end`)).toBe("data [REDACTED] end");
    const padded = Buffer.from("abcd").toString("base64"); // "YWJjZA=="
    const r2 = createValueRedactor(["abcd"]);
    expect(r2(`x ${padded} y`)).toBe("x [REDACTED] y");
    expect(r2(`x ${padded.replace(/=+$/, "")} y`)).toBe("x [REDACTED] y");
  });

  it("prefers the longest secret when secrets overlap", () => {
    const redact = createValueRedactor(["abc", "abcdef"]);
    expect(redact("xx abcdef yy abc")).toBe("xx [REDACTED] yy [REDACTED]");
    const redact2 = createValueRedactor(["pass", "password123"]);
    expect(redact2("password123")).toBe("[REDACTED]");
  });

  it("escapes regex metacharacters in secrets", () => {
    const redact = createValueRedactor(["a.b*c(d)[e]$^|\\"]);
    expect(redact("x a.b*c(d)[e]$^|\\ y")).toBe("x [REDACTED] y");
    expect(redact("x aXbbbc y")).toBe("x aXbbbc y");
  });

  it("ignores empty secrets and is a no-op with none", () => {
    const redact = createValueRedactor(["", ""]);
    expect(redact("anything")).toBe("anything");
    expect(createValueRedactor([])({ a: "b" })).toEqual({ a: "b" });
  });

  it("walks deep structures including arrays and does not mutate", () => {
    const redact = createValueRedactor(["topsecret"]);
    const input = { a: ["x topsecret", { b: "topsecret" }], n: 5, keep: "fine" };
    const snapshot = structuredClone(input);
    expect(redact(input)).toEqual({ a: ["x [REDACTED]", { b: "[REDACTED]" }], n: 5, keep: "fine" });
    expect(input).toEqual(snapshot);
  });

  it("redacts secrets inside Error messages and stacks without mutating the error", () => {
    const redact = createValueRedactor(["topsecret"]);
    const err = new TypeError("failed with topsecret");
    const out = redact({ err }) as { err: Error };
    expect(out.err).toBeInstanceOf(TypeError);
    expect(out.err.message).toBe("failed with [REDACTED]");
    expect(out.err.stack).toContain("TypeError: failed with [REDACTED]");
    expect(out.err.stack).not.toContain("topsecret");
    expect(err.stack).toContain("topsecret");
    expect(err.message).toBe("failed with topsecret");
  });

  it("does not key-redact", () => {
    const redact = createValueRedactor(["zzz"]);
    expect(redact({ password: "hello" })).toEqual({ password: "hello" });
  });
});

describe("createRunRedactor", () => {
  it("applies key and value redaction together", () => {
    const redact = createRunRedactor(["hunter2-long"]);
    expect(
      redact({
        headers: { Authorization: "Bearer abc" },
        log: ["typed hunter2-long into field"],
        url: `https://shop.test/?p=${encodeURIComponent("hunter2-long")}`,
        email: "qa@example.com",
      }),
    ).toEqual({
      headers: { Authorization: REDACTED },
      log: ["typed [REDACTED] into field"],
      url: "https://shop.test/?p=[REDACTED]",
      email: "qa@example.com",
    });
  });

  it("works with no secrets (key-only)", () => {
    expect(createRunRedactor([])({ token: "t", a: "b" })).toEqual({ token: REDACTED, a: "b" });
  });
});
