import { isInferred, type NormalizedRequirement } from "./requirement";
import type { RunVerdict } from "./run";

/**
 * What the analysis did on its own for a requirement (2026-11-11, spec intent-understanding), for the review, the
 * report and the Markdown report alike: the criteria it added, the vague wording it checked in a concrete way, and
 * its notes (e.g. a criterion it left out).
 */
export interface Assumption {
  kind: "added" | "assumed" | "note";
  criterionId: string | null;
  text: string;
}

export const ADDED_BY_PLATFORM = "Added by the platform";
export const PASSED_ON_ASSUMED = "Passed (on assumed checks)";

type Understood = { criteria: Pick<NormalizedRequirement["criteria"][number], "id" | "origin" | "rationale" | "assumption" | "critical">[]; intent?: NormalizedRequirement["intent"] };

/** Added criteria first (with why), then assumptions, then notes. */
export function assumptionsOf(requirement: Understood | null | undefined): Assumption[] {
  if (!requirement) return [];
  return [
    ...requirement.criteria.filter(isInferred).map((c): Assumption => ({ kind: "added", criterionId: c.id, text: c.rationale ?? "" })),
    ...requirement.criteria.flatMap((c): Assumption[] => (c.assumption ? [{ kind: "assumed", criterionId: c.id, text: c.assumption }] : [])),
    ...(requirement.intent?.notes ?? []).map((text): Assumption => ({ kind: "note", criterionId: null, text })),
  ];
}

/**
 * A PASSED verdict decided only by criteria the platform added: the user stated none of the checks that passed.
 * Never true for another verdict: a failure on an added check is still a failure, said plainly.
 */
export function passedOnAssumedChecks(report: { verdict: RunVerdict | null; requirement: Pick<Understood, "criteria"> | null }): boolean {
  if (report.verdict !== "PASSED" || !report.requirement) return false;
  const deciding = report.requirement.criteria.filter((c) => c.critical);
  return deciding.length > 0 && deciding.every(isInferred);
}
