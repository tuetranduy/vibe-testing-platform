/**
 * Deterministic post-validation of the model's output. Runs on every compile (real model output
 * included): it never trusts the model with ids, verbatim quotes, fact declarations or thresholds.
 */
import {
  NormalizedRequirementSchema,
  factRefsOf,
  type AcceptanceCriterion,
  type ExpectedOutcome,
  type TestDataValue,
} from "@platform/contracts";
import type { RequirementDraft } from "../orchestrator/stages";
import type { CompilerOutput } from "./model-output";

export const THRESHOLD_NOT_STATED = "Threshold not stated in requirement";

export type PostValidation = { ok: true; draft: RequirementDraft } | { ok: false; issues: string[] };

/**
 * Assemble the draft (ids AC-1…n), rewrite invented thresholds to `semantic`, then validate the
 * result with the shared schema. Schema issues (sourceText not verbatim, undeclared FactRef, …) are
 * returned for a correction round; the threshold rewrite is never a reason to retry.
 */
export function postValidate(
  output: CompilerOutput,
  source: { originalText: string; testData: Record<string, TestDataValue> },
): PostValidation {
  const assembled: RequirementDraft = {
    originalText: source.originalText,
    criteria: output.criteria.map((c, i) => ({ ...c, id: `AC-${i + 1}` })),
    facts: output.facts,
  };
  const draft = replaceUnstatedThresholds(assembled, statedNumbers(source.originalText, source.testData));
  const parsed = NormalizedRequirementSchema.safeParse({ ...draft, runId: "draft", revision: 1, confirmedAt: null });
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`) };
  }
  const { runId: _r, revision: _v, confirmedAt: _c, ...validated } = parsed.data;
  return { ok: true, draft: validated };
}

/**
 * Any number in an expected outcome that the requirement (or a testData value) does not state is an
 * invented threshold: the outcome becomes `semantic` (AI-judged, never PASS/FAIL) and is flagged.
 * Facts only the rewritten outcomes used are dropped.
 */
export function replaceUnstatedThresholds(draft: RequirementDraft, stated: Set<number>): RequirementDraft {
  const orphanCandidates = new Set<string>();
  const criteria = draft.criteria.map((c): AcceptanceCriterion => {
    const invented = numbersIn(c.expectedOutcome).some((n) => !stated.has(Math.abs(n)));
    if (!invented) return c;
    for (const { ref } of factRefsOf(c.expectedOutcome)) orphanCandidates.add(`${ref.key}@${ref.checkpoint}`);
    const suggestions = [...new Set([c.statement.slice(0, 300), ...(c.ambiguity?.suggestions ?? [])])].slice(0, 3);
    return {
      ...c,
      expectedOutcome: { kind: "semantic", description: c.sourceText.trim().length >= 3 ? c.sourceText.trim().slice(0, 1000) : c.statement },
      ambiguity: { reason: THRESHOLD_NOT_STATED, suggestions },
    };
  });
  const stillUsed = new Set(
    criteria.flatMap((c) => factRefsOf(c.expectedOutcome).map(({ ref }) => `${ref.key}@${ref.checkpoint}`)),
  );
  const facts = draft.facts.filter((f) => {
    const k = `${f.key}@${f.checkpoint}`;
    return !orphanCandidates.has(k) || stillUsed.has(k);
  });
  return { ...draft, criteria, facts };
}

/** Numbers an outcome asserts: numeric literals plus digits inside expected strings. */
function numbersIn(outcome: ExpectedOutcome): number[] {
  switch (outcome.kind) {
    case "numeric_compare":
      return typeof outcome.right === "number" ? [outcome.right] : [];
    case "numeric_delta":
      return [outcome.delta];
    case "text_matches":
      return numbersInText(outcome.match.value);
    case "collection_contains":
      return typeof outcome.item === "string" ? numbersInText(outcome.item) : [];
    case "visible":
    case "semantic":
      return [];
  }
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, twenty: 20, hundred: 100, thousand: 1000,
};

/** Every number the user stated: digits and English number words in the text, and testData values. */
export function statedNumbers(originalText: string, testData: Record<string, TestDataValue>): Set<number> {
  const out = new Set<number>(numbersInText(originalText));
  for (const word of originalText.toLowerCase().match(/[a-z]+/g) ?? []) {
    const n = NUMBER_WORDS[word];
    if (n !== undefined) out.add(n);
  }
  for (const v of Object.values(testData)) {
    if (typeof v === "number") out.add(Math.abs(v));
    else if (typeof v === "string") for (const n of numbersInText(v)) out.add(n);
  }
  return out;
}

/**
 * Absolute values of the numbers in a string. Grouped digits ("1,299", "2.000", "1'000", "1,5") are
 * read both as thousands-separated and as decimal, so either reading counts as stated.
 */
export function numbersInText(text: string): number[] {
  const out: number[] = [];
  for (const token of text.match(/\d+(?:[.,']\d+)*/g) ?? []) {
    const parts = token.split(/[.,']/);
    out.push(Number(parts.join("")));
    if (parts.length > 1) out.push(Number(`${parts.slice(0, -1).join("")}.${parts.at(-1)}`));
  }
  return out.filter(Number.isFinite);
}
