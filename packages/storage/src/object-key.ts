import { randomBytes } from "node:crypto";
import type { ArtifactType } from "@platform/contracts";
import { InvalidArtifactKeyError } from "./storage";

export const TYPE_DIRS: Readonly<Record<ArtifactType, string>> = Object.freeze({
  SCREENSHOT: "screenshots",
  TRACE: "traces",
  VIDEO: "videos",
  GENERATED_TEST: "generated-tests",
  PLAYWRIGHT_REPORT: "playwright-reports",
});

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_BASE_LENGTH = 64;
const MAX_EXT_LENGTH = 10;
const FALLBACK_BASE = "artifact";

const typeDirAlternation = Object.values(TYPE_DIRS).join("|");
/** Exactly the shape buildObjectKey produces — no `.`/`..` segments, no extra slashes. */
const OBJECT_KEY_RE = new RegExp(
  `^tenants/[A-Za-z0-9_-]{1,128}/runs/[A-Za-z0-9_-]{1,128}/(?:${typeDirAlternation})/[A-Za-z0-9_-]{1,${MAX_BASE_LENGTH + 20}}(?:\\.[a-z0-9]{1,${MAX_EXT_LENGTH}})?$`,
);

export interface ObjectKeyInput {
  tenantId: string;
  runId: string;
  type: ArtifactType;
  fileName: string;
}

function assertId(name: string, value: string): void {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new InvalidArtifactKeyError(`${name} must match ${ID_RE.source}, got ${JSON.stringify(value)}`);
  }
}

/**
 * Reduces an arbitrary file name to a safe `{ base, ext }`:
 * - only the last path segment (split on `/` and `\`) is kept;
 * - base: characters outside [A-Za-z0-9_-] become `-` (dots included), runs collapsed,
 *   leading/trailing `-` trimmed, capped at 64 chars, `artifact` if empty;
 * - ext: text after the last dot (not a leading dot), lower-cased, kept only if [a-z0-9]{1,10}.
 */
export function sanitizeFileName(fileName: string): { base: string; ext: string } {
  const segments = String(fileName ?? "")
    .split(/[/\\]/)
    .filter((s) => s.length > 0);
  const last = segments.at(-1) ?? "";
  const dot = last.lastIndexOf(".");
  let rawBase = last;
  let ext = "";
  if (dot > 0) {
    const candidate = last.slice(dot + 1).toLowerCase();
    if (new RegExp(`^[a-z0-9]{1,${MAX_EXT_LENGTH}}$`).test(candidate)) {
      ext = candidate;
      rawBase = last.slice(0, dot);
    }
  }
  const base =
    rawBase
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_BASE_LENGTH)
      .replace(/-+$/g, "") || FALLBACK_BASE;
  return { base, ext };
}

/** `tenants/<tenantId>/runs/<runId>/<typeDir>/<sanitizedBase>-<16 hex random>[.<ext>]` */
export function buildObjectKey({ tenantId, runId, type, fileName }: ObjectKeyInput): string {
  assertId("tenantId", tenantId);
  assertId("runId", runId);
  if (!Object.hasOwn(TYPE_DIRS, type)) {
    throw new InvalidArtifactKeyError(`unknown artifact type ${JSON.stringify(type)}`);
  }
  const dir = TYPE_DIRS[type];
  const { base, ext } = sanitizeFileName(fileName);
  const suffix = randomBytes(8).toString("hex");
  return `tenants/${tenantId}/runs/${runId}/${dir}/${base}-${suffix}${ext ? `.${ext}` : ""}`;
}

/** Throws InvalidArtifactKeyError unless `objectKey` has exactly the shape buildObjectKey produces. */
export function assertValidObjectKey(objectKey: string): void {
  if (typeof objectKey !== "string" || !OBJECT_KEY_RE.test(objectKey)) {
    throw new InvalidArtifactKeyError(`invalid artifact object key ${JSON.stringify(objectKey)}`);
  }
}
