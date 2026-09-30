import { createHash, randomBytes } from "node:crypto";

/** Prefixed, URL-safe, sortable-enough random id (e.g. run_3kq9x...). */
export function newId(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, "0");
  return `${prefix}_${time}${randomBytes(8).toString("hex")}`;
}

/**
 * The comparison key of a run of this test (V1.2 F2): SHA-256 of the target URL and the requirement text with its
 * whitespace collapsed (the migration's back-fill computes the same). Null for a blank requirement.
 */
export function comparisonKeyOf(targetUrl: string, requirement: string): string | null {
  // Exactly what Postgres' regexp_replace + btrim do in the back-fill (String.trim would drop more characters).
  const text = requirement.replace(/[ \t\n\r\f\v]+/g, " ").replace(/^ /, "").replace(/ $/, "");
  if (!text) return null;
  return createHash("sha256").update(`${targetUrl}\n${text}`, "utf8").digest("hex");
}
