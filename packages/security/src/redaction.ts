export const REDACTED = "[REDACTED]";

/** Key names (compared case-insensitively, ignoring `-` and `_`) whose values are always redacted. */
export const SENSITIVE_KEYS: readonly string[] = [
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
];

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[-_\s]/g, "");

const EXACT_KEYS = new Set(SENSITIVE_KEYS.map(normalizeKey));
// Variants such as `csrfToken`, `client_secret`, `newPassword`, `privateKey`.
// Deliberately suffix-based for token/secret so that LLM usage fields
// (`maxTokens`, `tokenCount`) and references like `secretName` stay visible.
const SENSITIVE_SUFFIXES = ["token", "secret", "password", "passwd", "apikey", "sessionid", "cookie", "privatekey", "secretkey"];
const SENSITIVE_SUBSTRINGS = ["password", "passwd"];

export function isSensitiveKey(key: string): boolean {
  const k = normalizeKey(key);
  if (EXACT_KEYS.has(k)) return true;
  if (SENSITIVE_SUFFIXES.some((s) => k.endsWith(s))) return true;
  return SENSITIVE_SUBSTRINGS.some((s) => k.includes(s));
}

interface WalkOptions {
  byKey: boolean;
  str: ((s: string) => string) | null;
}

function isOpaque(v: object): boolean {
  return (
    v instanceof Date ||
    v instanceof RegExp ||
    v instanceof ArrayBuffer ||
    ArrayBuffer.isView(v) || // Buffer, typed arrays, DataView
    v instanceof Promise ||
    v instanceof WeakMap ||
    v instanceof WeakSet ||
    typeof v === "function"
  );
}

/**
 * Deep copy with redaction. Never mutates the input. Cycles and shared
 * references are preserved in the output (each input object is copied once).
 *
 * - arrays, Maps, Sets: walked
 * - plain objects, Errors and other class instances: own properties copied onto
 *   an object with the same prototype (so `instanceof` still holds and Error
 *   `message`/`stack` are redacted)
 * - Date, RegExp, Buffer/typed arrays, Promise, functions: returned as-is
 * - URL: rebuilt from the redacted href when value redaction is active
 */
function walk(input: unknown, opts: WalkOptions): unknown {
  const seen = new WeakMap<object, unknown>();

  const redactSensitive = (v: unknown): unknown => (v === null || v === undefined ? v : REDACTED);

  const visit = (v: unknown): unknown => {
    if (typeof v === "string") return opts.str ? opts.str(v) : v;
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return seen.get(v);
    if (isOpaque(v)) return v;

    if (v instanceof URL) {
      if (!opts.str) return v;
      const href = opts.str(v.href);
      if (href === v.href) return v;
      try {
        return new URL(href);
      } catch {
        return href;
      }
    }

    if (Array.isArray(v)) {
      const out: unknown[] = [];
      seen.set(v, out);
      for (const item of v) out.push(visit(item));
      return out;
    }

    if (v instanceof Map) {
      const out = new Map<unknown, unknown>();
      seen.set(v, out);
      for (const [k, val] of v) {
        out.set(k, opts.byKey && typeof k === "string" && isSensitiveKey(k) ? redactSensitive(val) : visit(val));
      }
      return out;
    }

    if (v instanceof Set) {
      const out = new Set<unknown>();
      seen.set(v, out);
      for (const item of v) out.add(visit(item));
      return out;
    }

    const out = Object.create(Object.getPrototypeOf(v)) as object;
    seen.set(v, out);
    for (const key of Reflect.ownKeys(v)) {
      const desc = Object.getOwnPropertyDescriptor(v, key);
      if (!desc) continue;
      let raw: unknown;
      if ("value" in desc) {
        raw = desc.value;
      } else {
        // Own accessor (e.g. V8's Error#stack): materialize it so the copy
        // never calls back into the original object.
        try {
          raw = Reflect.get(v, key);
        } catch {
          raw = undefined;
        }
      }
      const value = opts.byKey && typeof key === "string" && isSensitiveKey(key) ? redactSensitive(raw) : visit(raw);
      Object.defineProperty(out, key, {
        value,
        enumerable: desc.enumerable ?? false,
        configurable: desc.configurable ?? false,
        writable: "value" in desc ? (desc.writable ?? false) : true,
      });
    }
    return out;
  };

  return visit(input);
}

/** Redact values stored under sensitive keys (see `SENSITIVE_KEYS` / `isSensitiveKey`), deeply. */
export function redactByKey(value: unknown): unknown {
  return walk(value, { byKey: true, str: null });
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** Escape a percent-encoded string, matching `%xx` escapes in either hex case. */
function percentPattern(encoded: string): string {
  return encoded
    .split(/(%[0-9A-Fa-f]{2})/)
    .map((part) =>
      /^%[0-9A-Fa-f]{2}$/.test(part)
        ? "%" + [...part.slice(1)].map((c) => (/[0-9]/.test(c) ? c : `[${c.toLowerCase()}${c.toUpperCase()}]`)).join("")
        : escapeRegex(part),
    )
    .join("");
}

function secretPatterns(secret: string): Array<{ length: number; pattern: string }> {
  const b64 = Buffer.from(secret, "utf8").toString("base64");
  const literal = [secret, b64, b64.replace(/=+$/, ""), Buffer.from(secret, "utf8").toString("base64url")];
  const percent = [encodeURIComponent(secret), new URLSearchParams([["", secret]]).toString().slice(1)];
  const out = new Map<string, number>();
  for (const f of literal) if (f) out.set(escapeRegex(f), f.length);
  for (const f of percent) if (f) out.set(percentPattern(f), f.length);
  return [...out].map(([pattern, length]) => ({ pattern, length }));
}

function buildStringRedactor(secretValues: string[]): ((s: string) => string) | null {
  const patterns = [...new Set(secretValues.filter((s) => typeof s === "string" && s.length > 0))]
    .flatMap(secretPatterns)
    // Longest first so that an overlapping shorter secret (or form) never wins.
    .sort((a, b) => b.length - a.length)
    .map((p) => p.pattern);
  if (patterns.length === 0) return null;
  const re = new RegExp([...new Set(patterns)].join("|"), "g");
  return (s) => s.replace(re, REDACTED);
}

/**
 * Redact every occurrence of each secret value — raw, URL-encoded
 * (`encodeURIComponent` and form `+` encoding, either hex case) and base64
 * (standard padded/unpadded and base64url) — inside any string, deeply.
 * Empty secret values are ignored. Object keys are not rewritten.
 */
export function createValueRedactor(secretValues: string[]): (value: unknown) => unknown {
  const str = buildStringRedactor(secretValues);
  return (value) => walk(value, { byKey: false, str });
}

/** Key-based and value-based redaction in a single pass. Use before persisting, logging, publishing or prompting. */
export function createRunRedactor(secretValues: string[]): (value: unknown) => unknown {
  const str = buildStringRedactor(secretValues);
  return (value) => walk(value, { byKey: true, str });
}
