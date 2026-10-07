import { describe, expect, it } from "vitest";
import { REDACTED, createRunRedactor, isSensitiveKey, redactByKey } from "./redaction";

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

  it.each(["apiKey", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "anthropic_api_key"])(
    "redacts the provider key field %s (settings bodies, environment dumps: the apikey suffix rule)",
    (key) => {
      expect(isSensitiveKey(key)).toBe(true);
      expect(redactByKey({ provider: "anthropic", [key]: "sk-ant-api03-x" })).toEqual({ provider: "anthropic", [key]: REDACTED });
    },
  );

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

describe("createRunRedactor", () => {
  it("redacts by key only: a run's secret values are kept as typed (2026-10-07)", () => {
    const redact = createRunRedactor();
    expect(
      redact({
        headers: { Authorization: "Bearer abc" },
        log: ["typed hunter2-long into field"],
        url: `https://shop.test/?p=${encodeURIComponent("hunter2-long")}`,
        password: "hunter2-long",
      }),
    ).toEqual({
      headers: { Authorization: REDACTED },
      log: ["typed hunter2-long into field"],
      url: "https://shop.test/?p=hunter2-long",
      password: REDACTED,
    });
  });

  it("matches redactByKey", () => {
    const value = { token: "t", a: "b", nested: [{ cookie: "c" }] };
    expect(createRunRedactor()(value)).toEqual(redactByKey(value));
  });
});
