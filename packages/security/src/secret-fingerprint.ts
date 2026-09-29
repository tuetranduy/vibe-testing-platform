import { createHmac, timingSafeEqual } from "node:crypto";
import { REDACTED } from "./redaction";

/**
 * Finds a run's secret values in text the API receives after the run was created (a suggestion's
 * edited wording, a criterion's check values) without decrypting them: D7 keeps secret plaintext
 * out of the API once the run exists. At creation, while the API still holds the plaintext, it
 * stores an HMAC of each value (keyed with SECRETS_ENCRYPTION_KEY) next to the ciphertext; later
 * text is scanned by HMAC-ing every UTF-8 window of each secret's byte length.
 *
 * Only the plain form is found (the worker's run redactor also masks encoded forms before any
 * model call). The byte length is not an extra leak: AES-GCM ciphertext has the plaintext's length.
 */

const DOMAIN = "run-secret-fingerprint\0";

export type SecretFingerprint = { digest: Buffer; bytes: number };

export function secretFingerprint(plain: string, key: Buffer): SecretFingerprint {
  const bytes = Buffer.byteLength(plain, "utf8");
  return { digest: hmac(key, Buffer.from(plain, "utf8")), bytes };
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(DOMAIN).update(data).digest();
}

/** Byte ranges [start, end) of `text`'s UTF-8 form that hold a fingerprinted value, sorted, non-overlapping. */
function findRanges(buf: Buffer, fingerprints: readonly SecretFingerprint[], key: Buffer): [number, number][] {
  const byLength = new Map<number, Buffer[]>();
  for (const fp of fingerprints) {
    if (fp.bytes <= 0 || fp.digest.length !== 32) continue;
    byLength.set(fp.bytes, [...(byLength.get(fp.bytes) ?? []), fp.digest]);
  }
  const ranges: [number, number][] = [];
  for (const [len, digests] of byLength) {
    for (let i = 0; i + len <= buf.length; i++) {
      // A secret's UTF-8 starts on a character boundary: skip continuation bytes.
      if ((buf[i]! & 0xc0) === 0x80) continue;
      const d = hmac(key, buf.subarray(i, i + len));
      if (digests.some((x) => timingSafeEqual(x, d))) ranges.push([i, i + len]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] < last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

/** True when `text` contains one of the fingerprinted values. */
export function containsFingerprintedSecret(text: string, fingerprints: readonly SecretFingerprint[], key: Buffer): boolean {
  if (fingerprints.length === 0 || text.length === 0) return false;
  return findRanges(Buffer.from(text, "utf8"), fingerprints, key).length > 0;
}

/** `text` with every fingerprinted value replaced by `[REDACTED]`. */
export function redactFingerprintedSecrets(text: string, fingerprints: readonly SecretFingerprint[], key: Buffer): string {
  if (fingerprints.length === 0 || text.length === 0) return text;
  const buf = Buffer.from(text, "utf8");
  const ranges = findRanges(buf, fingerprints, key);
  if (ranges.length === 0) return text;
  const parts: Buffer[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    parts.push(buf.subarray(at, start), Buffer.from(REDACTED, "utf8"));
    at = end;
  }
  parts.push(buf.subarray(at));
  return Buffer.concat(parts).toString("utf8");
}
