import { createValueRedactor, REDACTED } from "@platform/security";
import { unzipSync, zipSync, type Unzipped } from "fflate";

/**
 * Trace scrubber (Task 17, Step 5): a Playwright trace is a zip of NDJSON events (`*.trace`,
 * `*.network`), sources and resource blobs (`resources/<sha1>`: page HTML, posted bodies, response
 * bodies, screenshots). A secret the rerun filled shows up in action params and titles, request
 * headers, URLs and bodies. Before a trace is uploaded, every secret value is removed from every
 * entry, in every form it can take there:
 *
 * - text entries (valid UTF-8): the run redactor's forms — plain, URL-encoded (`encodeURIComponent`
 *   and form `+` encoding, either hex case), base64 / base64url of the whole value — plus the forms
 *   specific to traces: JSON-escaped (also with non-ASCII as `\uXXXX`), HTML-escaped, and the part of
 *   a base64 encoding that depends only on the secret when it sits inside a longer encoded value
 *   (e.g. `Authorization: Basic base64(user:secret)`), at each of the three byte alignments;
 * - binary entries (images, other blobs): the same literal forms are masked in place, byte for byte.
 *
 * The trace stays a valid trace (events keep parsing, with `[REDACTED]` in place of the value). A
 * zip that cannot be read is not guessed at: `TraceScrubError`, and the caller drops the trace.
 */

export class TraceScrubError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TraceScrubError";
  }
}

/** Refuse to inflate more than this (a trace of one short test is a few MB). */
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
/** Shorter derived fragments would match unrelated text; the plain value is always removed. */
const MIN_FRAGMENT_LENGTH = 4;

const jsonEscaped = (s: string) => JSON.stringify(s).slice(1, -1);
const jsonAsciiEscaped = (s: string) => jsonEscaped(s).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const htmlEscaped = (s: string, apos: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, apos);

/**
 * The characters of base64(prefix + secret + suffix) that depend on the secret alone, for a prefix of
 * `offset` bytes (0, 1 or 2 — all alignments): drop the leading characters that mix in prefix bits
 * and the trailing ones that mix in suffix bits (and the padding).
 */
function base64Fragments(secret: string): string[] {
  const bytes = Buffer.from(secret, "utf8");
  const out: string[] = [];
  for (const offset of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64");
    const start = Math.ceil((offset * 8) / 6);
    const end = Math.floor(((offset + bytes.length) * 8) / 6);
    const fragment = encoded.slice(start, end);
    if (fragment.length >= MIN_FRAGMENT_LENGTH) out.push(fragment, fragment.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return out;
}

/** Literal forms of a secret (beyond the run redactor's) that a trace entry may hold. */
function traceForms(secret: string): string[] {
  const forms = new Set([
    secret,
    jsonEscaped(secret),
    jsonAsciiEscaped(secret),
    htmlEscaped(secret, "&#39;"),
    htmlEscaped(secret, "&#x27;"),
    encodeURIComponent(secret),
    encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
    new URLSearchParams([["", secret]]).toString().slice(1),
    Buffer.from(secret, "utf8").toString("base64"),
    Buffer.from(secret, "utf8").toString("base64url"),
    ...base64Fragments(secret),
  ]);
  return [...forms].filter((f) => f.length > 0).sort((a, b) => b.length - a.length);
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

interface Scrubber {
  text(s: string): string;
  binary(bytes: Uint8Array): Uint8Array;
}

function createScrubber(secretValues: string[]): Scrubber {
  const secrets = [...new Set(secretValues.filter((s) => typeof s === "string" && s.length > 0))];
  const runRedactor = createValueRedactor(secrets);
  const forms = [...new Set(secrets.flatMap(traceForms))].sort((a, b) => b.length - a.length);
  const extra = new RegExp(forms.map(escapeRegex).join("|"), "g");
  const needles = forms.map((f) => Buffer.from(f, "utf8"));
  return {
    text: (s) => (runRedactor(s) as string).replace(extra, REDACTED),
    binary(bytes) {
      const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let out: Buffer | undefined;
      for (const needle of needles) {
        let at = (out ?? view).indexOf(needle);
        while (at >= 0) {
          out ??= Buffer.from(view); // copy on the first hit; masked in place so the size is kept
          out.fill(0x2a, at, at + needle.length); // "*"
          at = out.indexOf(needle, at + needle.length);
        }
      }
      return out ?? bytes;
    },
  };
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeText(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

function readZip(zip: Uint8Array): Unzipped {
  if (zip.length === 0) throw new TraceScrubError("The trace is empty");
  let total = 0;
  try {
    return unzipSync(zip, {
      filter: (file) => {
        total += file.originalSize;
        if (total > MAX_UNCOMPRESSED_BYTES) throw new TraceScrubError("The trace is too large to scrub");
        return true;
      },
    });
  } catch (err) {
    if (err instanceof TraceScrubError) throw err;
    throw new TraceScrubError("The trace is not a readable zip archive", { cause: err });
  }
}

/**
 * Returns the trace with every secret value removed from every entry. No secrets → the input,
 * untouched. Throws TraceScrubError when the zip cannot be read (the caller drops the trace).
 */
export function scrubTrace(zip: Uint8Array, secretValues: string[]): Uint8Array {
  if (!secretValues.some((s) => typeof s === "string" && s.length > 0)) return zip;
  const entries = readZip(zip);
  const scrubber = createScrubber(secretValues);
  const out: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(entries)) {
    const text = decodeText(bytes);
    out[name] = text === null ? scrubber.binary(bytes) : Buffer.from(scrubber.text(text), "utf8");
  }
  try {
    return zipSync(out, { level: 6 });
  } catch (err) {
    throw new TraceScrubError("The scrubbed trace could not be written", { cause: err });
  }
}
