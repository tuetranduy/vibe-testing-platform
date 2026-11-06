/**
 * Deterministic post-validation of the model's output. Runs on every compile (real model output
 * included): it never trusts the model with ids, verbatim quotes, fact declarations or thresholds.
 */
import {
  NormalizedRequirementSchema,
  URL_FACT_KEY,
  factRefsOf,
  type AcceptanceCriterion,
  type ExpectedOutcome,
  type FactRequest,
  type TestDataValue,
} from "@platform/contracts";
import type { RequirementDraft } from "../orchestrator/stages";
import type { CompilerOutput } from "./model-output";

export const THRESHOLD_NOT_STATED = "Threshold not stated in requirement";
/** The ambiguity reason of a text check rewritten to `visible` (KI-070). */
export const TEXT_NOT_STATED = "Exact text not stated in requirement: checked that it is shown";

export type PostValidation = { ok: true; draft: RequirementDraft } | { ok: false; issues: string[] };

/**
 * Assemble the draft (ids AC-1…n), rewrite invented thresholds to `semantic`, then validate the
 * result with the shared schema. Schema issues (sourceText not verbatim, undeclared FactRef, …) are
 * returned for a correction round; the threshold rewrite is never a reason to retry.
 *
 * A text check against a test data value (KI-001) must name test data, never a secret (a correction round), and
 * gets that key's `test_data` precondition when the model left it out, so a run without the value is BLOCKED.
 */
export function postValidate(
  output: Pick<CompilerOutput, "criteria" | "facts">,
  source: { originalText: string; testData: Record<string, TestDataValue>; secretNames?: readonly string[] },
): PostValidation {
  const assembled: RequirementDraft = {
    originalText: source.originalText,
    criteria: output.criteria.map((c, i) => ({ ...c, id: `AC-${i + 1}`, critical: true })),
    facts: output.facts,
  };
  const draft = withTestDataPreconditions(
    replaceUnstatedTexts(replaceUnstatedThresholds(assembled, statedNumbers(source.originalText, source.testData)), source),
  );
  const secretIssues = draft.criteria.flatMap((c, i) => {
    const key = c.expectedOutcome.kind === "text_matches" ? c.expectedOutcome.match.testDataKey : undefined;
    return key !== undefined && (source.secretNames ?? []).includes(key)
      ? [`criteria.${i}.expectedOutcome.match.testDataKey: "${key}" is a secret; a secret is never compared or shown, only test data`]
      : [];
  });
  if (secretIssues.length > 0) return { ok: false, issues: secretIssues };
  const parsed = NormalizedRequirementSchema.safeParse({ ...draft, runId: "draft", revision: 1, confirmedAt: null });
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`) };
  }
  const { runId: _r, revision: _v, confirmedAt: _c, ...validated } = parsed.data;
  return { ok: true, draft: validated };
}

/** A text check's test data key comes with that key's `test_data` precondition (added when missing). */
function withTestDataPreconditions(draft: RequirementDraft): RequirementDraft {
  const criteria = draft.criteria.map((c): AcceptanceCriterion => {
    const key = c.expectedOutcome.kind === "text_matches" ? c.expectedOutcome.match.testDataKey : undefined;
    if (key === undefined || c.preconditions.some((p) => p.kind === "test_data" && p.ref === key)) return c;
    return { ...c, preconditions: [...c.preconditions, { kind: "test_data", ref: key, description: `The test data value “${key}”` }] };
  });
  return { ...draft, criteria };
}

/**
 * Any non-zero number in an expected outcome that the requirement (or a testData value) does not state is an
 * invented threshold: the outcome becomes `semantic` (judged by AI from what the page shows) and is flagged.
 * Facts only the rewritten outcomes used are dropped.
 */
export function replaceUnstatedThresholds(draft: RequirementDraft, stated: Set<number>): RequirementDraft {
  const orphanCandidates = new Set<string>();
  const criteria = draft.criteria.map((c): AcceptanceCriterion => {
    // 0 is always stated: "not empty", "no errors", "appears" compare against zero without saying so.
    const invented = numbersIn(c.expectedOutcome).some((n) => n !== 0 && !stated.has(Math.abs(n)));
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

/** Lower case, punctuation and symbols as spaces, whitespace collapsed: "“Wishlist is empty.”" → "wishlist is empty". */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * KI-070: a text check (`text_matches` equals / contains) whose literal value the requirement does not write (nor a
 * test data value) is wording the model made up, e.g. "Wishlist is empty" for "Make sure the wishlist works", where
 * the site says "No products were added to the Wishlist." Like an invented threshold, it is rewritten, never retried:
 * the outcome becomes `visible` on a boolean fact read at the same checkpoint (`<key>Shown`, "Whether … is shown"),
 * so the check is that the element is there, not what it says, and the criterion is flagged with TEXT_NOT_STATED.
 * A regex is left alone (a format, not wording), and so are a check against a test data key and one on the reserved
 * `url` fact (the route, not the page's wording). Facts only the
 * rewritten outcomes used are dropped.
 */
export function replaceUnstatedTexts(
  draft: RequirementDraft,
  source: { originalText: string; testData: Record<string, TestDataValue> },
): RequirementDraft {
  const stated = [source.originalText, ...Object.values(source.testData).filter((v): v is string => typeof v === "string")].map(normalizeText);
  const byRef = new Map(draft.facts.map((f) => [`${f.key}@${f.checkpoint}`, f]));
  const added: FactRequest[] = [];
  const orphanCandidates = new Set<string>();
  const criteria = draft.criteria.map((c): AcceptanceCriterion => {
    const outcome = c.expectedOutcome;
    if (outcome.kind !== "text_matches" || outcome.match.mode === "regex" || outcome.match.value === undefined) return c;
    if (outcome.fact.key === URL_FACT_KEY) return c; // an address check is about the route, not the page's wording
    const value = normalizeText(outcome.match.value);
    if (value === "" || stated.some((t) => t.includes(value))) return c;
    const { key, checkpoint } = outcome.fact;
    // A key of its own at the checkpoint (never one the model declared); two rewrites of one fact share it.
    const base = `${key.slice(0, 58)}Shown`;
    let shown = base;
    for (let n = 2; byRef.has(`${shown}@${checkpoint}`); n++) shown = `${base}${n}`;
    if (!added.some((f) => f.key === shown && f.checkpoint === checkpoint)) {
      const what = byRef.get(`${key}@${checkpoint}`)?.description ?? c.statement;
      added.push({ key: shown, checkpoint, description: `Whether this is shown: ${what}`.slice(0, 500), valueType: "boolean" });
    }
    orphanCandidates.add(`${key}@${checkpoint}`);
    const suggestions = [...new Set([c.statement.slice(0, 300), ...(c.ambiguity?.suggestions ?? [])])].slice(0, 3);
    return {
      ...c,
      expectedOutcome: { kind: "visible", fact: { key: shown, checkpoint }, expected: true },
      ambiguity: { reason: `${TEXT_NOT_STATED} (the model expected "${outcome.match.value.slice(0, 200)}")`.slice(0, 500), suggestions },
    };
  });
  if (added.length === 0) return draft;
  const stillUsed = new Set(criteria.flatMap((c) => factRefsOf(c.expectedOutcome).map(({ ref }) => `${ref.key}@${ref.checkpoint}`)));
  const facts = [
    ...draft.facts.filter((f) => {
      const k = `${f.key}@${f.checkpoint}`;
      return !orphanCandidates.has(k) || stillUsed.has(k);
    }),
    ...added,
  ];
  return { ...draft, criteria, facts };
}

/**
 * Numbers an outcome asserts: numeric literals plus digits inside expected strings. Regex patterns are
 * not scanned: their digits are quantifiers and classes (`\d{6}`), not asserted values.
 */
function numbersIn(outcome: ExpectedOutcome): number[] {
  switch (outcome.kind) {
    case "numeric_compare":
      return typeof outcome.right === "number" ? [outcome.right] : [];
    case "numeric_delta":
      return [outcome.delta];
    case "text_matches":
      // A test data value is the user's, never invented.
      return outcome.match.mode === "regex" || outcome.match.value === undefined ? [] : numbersInText(outcome.match.value);
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
