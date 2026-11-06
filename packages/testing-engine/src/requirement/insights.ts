/**
 * Deterministic post-validation of the compile call's advisory output (V1.3): the per-criterion site checks
 * and the suggested test data. Never a reason for a correction round — what is invalid is dropped, and every
 * needed test data key the model gave no usable value for gets one from the platform's generator.
 */
import {
  DataKeySchema,
  MAX_TEST_DATA_SUGGESTIONS,
  SuggestedTestDataValueSchema,
  generateTestDataValue,
  isCredentialKey,
  isEmailKey,
  type SiteCheck,
  type SitePage,
  type TestDataSuggestion,
  type TestDataValue,
} from "@platform/contracts";
import type { RequirementDraft } from "../orchestrator/stages";
import type { CompilerOutput } from "./model-output";

export interface RequirementInsights {
  checks: SiteCheck[];
  testData: TestDataSuggestion[];
}

export interface InsightsSource {
  draft: RequirementDraft;
  output: Pick<CompilerOutput, "siteChecks" | "testData">;
  /** The run's own test data: its keys need no suggestion. */
  testData: Record<string, TestDataValue>;
  secretNames: string[];
  /** Pages of the live site were read (the model's site checks and "from the site" values mean something). */
  siteRead: boolean;
  /** The pages read (their link inventories pick a product name for a search term, KI-071). Absent: none. */
  pages?: readonly SitePage[];
  /** Seeds the generator (the run id: reproducible per run). */
  seed: string;
  /** The run redactor: a value that carries a secret value is dropped, never masked into a suggestion. */
  redact: (value: unknown) => unknown;
}

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

const STATUS = { found: "FOUND", not_found: "NOT_FOUND", unclear: "UNCLEAR" } as const;

/** The test data keys the criteria's preconditions name that the run does not have (never a secret's name). */
export function neededTestDataKeys(draft: RequirementDraft, provided: Record<string, TestDataValue>, secretNames: string[]): Map<string, string> {
  const needed = new Map<string, string>();
  for (const c of draft.criteria) {
    for (const p of c.preconditions) {
      if (p.kind !== "test_data" || !p.ref) continue;
      if (!DataKeySchema.safeParse(p.ref).success || Object.hasOwn(provided, p.ref) || secretNames.includes(p.ref)) continue;
      if (!needed.has(p.ref)) needed.set(p.ref, p.description);
    }
  }
  return needed;
}

export function validateInsights(src: InsightsSource): RequirementInsights {
  const n = src.draft.criteria.length;
  const checks: SiteCheck[] = [];
  if (src.siteRead) {
    const seen = new Set<number>();
    for (const c of src.output.siteChecks) {
      if (!Number.isInteger(c.criterion) || c.criterion < 1 || c.criterion > n || seen.has(c.criterion)) continue;
      seen.add(c.criterion);
      checks.push({ criterionId: src.draft.criteria[c.criterion - 1]!.id, status: STATUS[c.status], note: clip(String(src.redact(c.note)), 300) });
    }
    checks.sort((a, b) => Number(a.criterionId.slice(3)) - Number(b.criterionId.slice(3)));
  }

  const testData: TestDataSuggestion[] = [];
  for (const [key, hint] of neededTestDataKeys(src.draft, src.testData, src.secretNames)) {
    if (testData.length >= MAX_TEST_DATA_SUGGESTIONS) break;
    if (isCredentialKey(key)) continue; // a credential is a secret: never suggested as test data
    const fromModel = src.output.testData.find((t) => t.key === key && usable(t.value, src.redact));
    // A made-up email (not one the site shows) is the platform's, unique to the run (KI-063): the model suggests the
    // same address every time, and an account registered with it once is "already taken" for every later run.
    const madeUpEmail = fromModel !== undefined && !(fromModel.fromSite && src.siteRead) && isEmailKey(key);
    if (fromModel && !madeUpEmail) {
      let value = typeof fromModel.value === "string" ? fromModel.value.trim() : fromModel.value;
      // A search term must name a product, or the search finds nothing (KI-071: "Lemonade", a gallery heading on a
      // CMS page): a term that is no product link's text is replaced by the first product the pages link to.
      if (src.siteRead && isSearchTermKey(key, hint) && typeof value === "string") {
        const products = productNames(src.pages ?? []);
        if (products.length > 0 && !products.some((p) => p.toLowerCase() === String(value).toLowerCase())) value = products[0]!;
      }
      testData.push({
        key,
        value,
        description: clip(String(src.redact(fromModel.description || hint)), 300),
        source: fromModel.fromSite && src.siteRead ? "SITE" : "GENERATED",
      });
      continue;
    }
    const generated = generateTestDataValue(key, { hint, seed: src.seed });
    const description = madeUpEmail ? String(src.redact(fromModel.description || hint)) : hint;
    if (generated !== null) testData.push({ key, value: generated, description: clip(description || `A value for ${key}`, 300), source: "GENERATED" });
  }
  return { checks, testData };
}

/**
 * A product id as a URL's last path segment: digits, optionally after a short prefix and with a variant suffix
 * (941044, SW10095.1, SW10100, 42), or a slug ending in one (iphone-17-pro-1234). Not a hash
 * (/navigation/1ccd9d102a684e38b56eb32abece80eb) nor a single digit (Product-listing-1).
 */
const PRODUCT_ID = /^(?:[A-Za-z]{0,4}\d{2,12}(?:[._-]\d{1,4})?|[\p{L}\p{N}-]+-\d{2,12})$/u;

const SEARCH_WORDS = new Set(["search", "query", "keyword", "keywords", "term", "q"]);

/** A test data key for what is typed into a search: searchTerm, query, keyword, q, … (or its hint says so). */
export function isSearchTermKey(key: string, hint = ""): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[\s_-]+/);
  return words.some((w) => SEARCH_WORDS.has(w)) || /\bsearch (?:term|query|word)\b/i.test(hint);
}

/**
 * The names of the products the pages link to, in page order: a main-area link whose URL's last path segment is a
 * product id (PRODUCT_ID: /Fred-3-Burner-Gas-Grill/941044, /Hawaii-sea-salt-Black-Lava/SW10092.1, /products/42) and
 * whose text is a short name. Categories ("/Products/Product-listing-1/"), CMS and navigation pages do not qualify.
 */
export function productNames(pages: readonly SitePage[]): string[] {
  const out: string[] = [];
  for (const page of pages) {
    for (const link of page.inventory.links) {
      if (link.area !== "main") continue;
      const text = link.text.replace(/\s+/g, " ").trim();
      if (text.length < 3 || text.length > 60) continue;
      let last = "";
      try {
        last = new URL(link.url, page.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
      } catch {
        continue;
      }
      if (PRODUCT_ID.test(last) && !out.includes(text)) out.push(text);
    }
  }
  return out;
}

/** A suggested value the platform can use: valid, finite, and not carrying one of the run's secret values. */
function usable(value: string | number | boolean, redact: (v: unknown) => unknown): boolean {
  const v = typeof value === "string" ? value.trim() : value;
  if (!SuggestedTestDataValueSchema.safeParse(v).success) return false;
  if (typeof v === "number" && !Number.isFinite(v)) return false;
  return typeof v !== "string" || redact(v) === v;
}
