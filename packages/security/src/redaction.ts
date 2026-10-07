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
 * - URL: returned as-is
 */
function walk(input: unknown): unknown {
  const seen = new WeakMap<object, unknown>();

  const redactSensitive = (v: unknown): unknown => (v === null || v === undefined ? v : REDACTED);

  const visit = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return seen.get(v);
    if (isOpaque(v)) return v;

    if (v instanceof URL) return v;

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
        out.set(k, typeof k === "string" && isSensitiveKey(k) ? redactSensitive(val) : visit(val));
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
      const value = typeof key === "string" && isSensitiveKey(key) ? redactSensitive(raw) : visit(raw);
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
  return walk(value);
}

/**
 * The run's redactor: key-based redaction (see `redactByKey`). A run's secret values are no longer masked (2026-10-07,
 * spec 2026-10-07-generated-inputs-no-redaction): they show as typed in events, reports, evidence and prompts.
 */
export function createRunRedactor(): (value: unknown) => unknown {
  return redactByKey;
}
