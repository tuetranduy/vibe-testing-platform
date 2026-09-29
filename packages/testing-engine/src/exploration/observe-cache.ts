import { createHash } from "node:crypto";
import type { CachedElement } from "@platform/contracts";

/**
 * The exploration cache port (V1.1 F8), implemented by the worker over `exploration_cache`. Stagehand's own
 * cache works only on Browserbase (A3), so the executor caches its element lookups (`observe`) itself.
 * Model extractions are never cached: facts are page values and are read on every run.
 *
 * Every method may fail: the executor treats a failing cache as a miss and never fails a step over it.
 */
export interface ObserveCache {
  get(key: string): Promise<CachedElement | null>;
  put(key: string, where: CacheWhere, entry: CachedElement): Promise<void>;
  /** Counts a reuse (hits, last used). */
  touch(key: string): Promise<void>;
}

export interface CacheWhere {
  origin: string;
  path: string;
}

/**
 * The cache key of a lookup: the page's origin and path (never its query or fragment, which can carry
 * personal data or session ids) and the redacted instruction. Null for a page that is not http(s).
 */
export function observeCacheKey(pageUrl: string, redactedInstruction: string): { key: string; where: CacheWhere } | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const where = { origin: url.origin, path: url.pathname };
  const key = createHash("sha256").update(`${where.origin}${where.path}\n${redactedInstruction}`, "utf8").digest("hex");
  return { key, where };
}
