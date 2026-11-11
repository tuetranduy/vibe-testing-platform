/**
 * Deterministic handling of what the analysis adds on its own (2026-11-11, spec intent-understanding): an inferred
 * criterion is kept only when the requirement leaves room for it and the pages read show what it checks, and a
 * partly invalid answer keeps its valid criteria instead of failing the run. Nothing here trusts the model: its
 * `origin` can only lower a criterion's standing (an inferred one can be dropped), never raise it.
 */
import { MAX_INFERRED_CRITERIA, factRefsOf, isInferred } from "@platform/contracts";
import { assertActionAllowed } from "@platform/security";
import type { CompilerOutput } from "./model-output";

export const LEFT_OUT = (statement: string, why: string): string => `Left out: ${statement} (${why})`.slice(0, 300);
export const WHOLE_REQUIREMENT_NOTE = "The requirement could not be split into checks; it is judged as a whole from what the pages show";

export interface GroundingContext {
  /** Pages of the live site were read for this analysis. */
  pagesRead: boolean;
  /** The secrets the run has (names only). */
  secretNames: readonly string[];
}

export interface Reduced {
  output: CompilerOutput;
  notes: string[];
}

/** Why an inferred criterion cannot stay, or null when it can. `kept` counts the inferred criteria kept before it. */
function whyNot(output: CompilerOutput, index: number, kept: number, ctx: GroundingContext): string | null {
  const c = output.criteria[index]!;
  if (output.intent === null || output.intent.clarity === "specific") return "the requirement already says what to check";
  if (!ctx.pagesRead) return "no pages of the site were read";
  const check = output.siteChecks.find((s) => s.criterion === index + 1);
  if (check?.status !== "found") return "the pages read do not show it";
  if (!assertActionAllowed({ instruction: c.statement }, { allowDestructive: false }).allowed) return "it would change or delete data";
  if (c.preconditions.some((p) => p.kind === "secret" && !(p.ref !== undefined && ctx.secretNames.includes(p.ref)))) {
    return "it needs a credential the run does not have";
  }
  if (kept >= MAX_INFERRED_CRITERIA) return `more than ${MAX_INFERRED_CRITERIA} checks were added`;
  return null;
}

/** Drops the inferred criteria that are not grounded (spec 5.3). Stated criteria are never touched. */
export function groundInferred(output: CompilerOutput, ctx: GroundingContext): Reduced {
  const drop = new Map<number, string>();
  let kept = 0;
  output.criteria.forEach((c, i) => {
    if (!isInferred(c)) return;
    const why = whyNot(output, i, kept, ctx);
    if (why === null) kept++;
    else drop.set(i, why);
  });
  return without(output, drop);
}

/**
 * Keeps what is valid of an answer that still fails validation after the correction round: every criterion an
 * issue points at (`criteria.<i>.…`) is dropped. Null when an issue names no criterion (the answer is broken as a
 * whole) or when nothing would be left.
 */
export function salvage(output: CompilerOutput, issues: readonly string[]): Reduced | null {
  const drop = new Map<number, string>();
  for (const issue of issues) {
    const index = /^criteria\.(\d+)\b/.exec(issue)?.[1];
    if (index === undefined || Number(index) >= output.criteria.length) return null;
    drop.set(Number(index), "could not be turned into a check");
  }
  if (drop.size === 0 || drop.size >= output.criteria.length) return null;
  return without(output, drop);
}

/** The output without the criteria at `drop`: site checks renumbered, facts no remaining criterion reads removed. */
function without(output: CompilerOutput, drop: ReadonlyMap<number, string>): Reduced {
  if (drop.size === 0) return { output, notes: [] };
  const criteria = output.criteria.filter((_c, i) => !drop.has(i));
  const refsOf = (cs: CompilerOutput["criteria"]) => new Set(cs.flatMap((c) => factRefsOf(c.expectedOutcome).map(({ ref }) => `${ref.key}@${ref.checkpoint}`)));
  const dropped = refsOf(output.criteria.filter((_c, i) => drop.has(i)));
  const used = refsOf(criteria);
  // Position i + 1 before → its position after, for the criteria that stay.
  const position = new Map<number, number>();
  output.criteria.forEach((_c, i) => {
    if (!drop.has(i)) position.set(i + 1, position.size + 1);
  });
  return {
    output: {
      ...output,
      criteria,
      facts: output.facts.filter((f) => {
        const k = `${f.key}@${f.checkpoint}`;
        return !dropped.has(k) || used.has(k);
      }),
      siteChecks: output.siteChecks.flatMap((s) => {
        const at = position.get(s.criterion);
        return at === undefined ? [] : [{ ...s, criterion: at }];
      }),
    },
    notes: [...drop].sort(([a], [b]) => a - b).map(([i, why]) => LEFT_OUT(output.criteria[i]!.statement, why)),
  };
}

/** When no criterion survives: the whole requirement as one criterion, judged by AI from what the pages show. */
export function wholeRequirementFallback(originalText: string): Pick<CompilerOutput, "criteria" | "facts"> {
  const text = originalText.replace(/\s+/g, " ").trim().slice(0, 1000);
  const description = text.length >= 3 ? text : "The requirement holds";
  return {
    criteria: [{ sourceText: originalText, statement: description, expectedOutcome: { kind: "semantic", description }, preconditions: [], ambiguity: null }],
    facts: [],
  };
}
