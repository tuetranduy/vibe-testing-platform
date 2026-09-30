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
  type SiteCheck,
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
    if (fromModel) {
      const value = typeof fromModel.value === "string" ? fromModel.value.trim() : fromModel.value;
      testData.push({
        key,
        value,
        description: clip(String(src.redact(fromModel.description || hint)), 300),
        source: fromModel.fromSite && src.siteRead ? "SITE" : "GENERATED",
      });
      continue;
    }
    const generated = generateTestDataValue(key, { hint, seed: src.seed });
    if (generated !== null) testData.push({ key, value: generated, description: clip(hint || `A value for ${key}`, 300), source: "GENERATED" });
  }
  return { checks, testData };
}

/** A suggested value the platform can use: valid, finite, and not carrying one of the run's secret values. */
function usable(value: string | number | boolean, redact: (v: unknown) => unknown): boolean {
  const v = typeof value === "string" ? value.trim() : value;
  if (!SuggestedTestDataValueSchema.safeParse(v).success) return false;
  if (typeof v === "number" && !Number.isFinite(v)) return false;
  return typeof v !== "string" || redact(v) === v;
}
