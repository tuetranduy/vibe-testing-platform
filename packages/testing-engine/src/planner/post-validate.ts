/**
 * Deterministic validation of the planner model's output against the confirmed requirement. Any
 * issue returned here is a model contract violation: it triggers the single correction round, then
 * ContractError. The model is never trusted with step ids, criterion ids or checkpoint coverage.
 */
import { factRefsOf, type AcceptanceCriterion, type FactRequest, type PlannedStep } from "@platform/contracts";
import type { PlannerOutput } from "./model-output";

/** A validated scenario: its title, its steps (ids unique across the plan) and the criteria it serves. */
export interface ValidatedScenario {
  title: string;
  steps: PlannedStep[];
  criterionIds: string[];
}

export type PlanValidation = { ok: true; scenarios: ValidatedScenario[] } | { ok: false; issues: string[] };

/** The checkpoints whose facts a criterion's expected outcome reads, in outcome order (semantic → none). */
export function neededCheckpoints(criterion: AcceptanceCriterion): string[] {
  return [...new Set(factRefsOf(criterion.expectedOutcome).map(({ ref }) => ref.checkpoint))];
}

const BEFORE = /^before(_|$)/;
const AFTER = /^after(_|$)/;

/**
 * Pairs [earlier, later] that must be captured in that order:
 * - `numeric_delta`: `before` precedes `after` (the outcome says so explicitly);
 * - any other outcome reading two checkpoints: by naming convention, a `before*` checkpoint precedes an
 *   `after*` one. Other pairs (e.g. `product_page` vs `cart_page`) carry no order the planner can
 *   check deterministically, so none is imposed.
 */
export function checkpointOrder(criteria: AcceptanceCriterion[]): [string, string][] {
  const pairs = new Map<string, [string, string]>();
  const add = (a: string, b: string) => {
    if (a !== b) pairs.set(`${a}>${b}`, [a, b]);
  };
  for (const c of criteria) {
    const outcome = c.expectedOutcome;
    if (outcome.kind === "numeric_delta") add(outcome.before.checkpoint, outcome.after.checkpoint);
    const cps = neededCheckpoints(c);
    for (const a of cps) for (const b of cps) if (BEFORE.test(a) && AFTER.test(b)) add(a, b);
  }
  return [...pairs.values()];
}

/**
 * Check the model output and assemble the scenarios (V1.1 F9): step ids PS-1…n across the whole plan, null
 * fields dropped, and each capture step lists every criterion whose facts are read at its checkpoint (plus
 * the ones the model named). Across the plan every checkpoint is captured exactly once; a criterion's
 * checkpoints, and every ordered pair of checkpoints, must be in one scenario (each scenario starts from a
 * clean session, so state does not carry over); each scenario has at most one login step and serves at
 * least one criterion (when there are several). A criterion belongs to the scenario that captures its
 * checkpoints; one without facts (`semantic`) to the first scenario whose steps name it, else the first.
 * The `destructive` flag is the model's; the action policy is applied later (see blocking.ts).
 */
export function validatePlanOutput(
  output: PlannerOutput,
  requirement: { criteria: AcceptanceCriterion[]; facts: FactRequest[] },
): PlanValidation {
  const issues: string[] = [];
  const criterionIds = requirement.criteria.map((c) => c.id);
  const known = new Set(criterionIds);
  const at = (si: number, i: number) => (output.scenarios.length > 1 ? `scenarios.${si}.steps.${i}` : `steps.${i}`);

  /** checkpoint → where it is captured: [scenario, step] pairs. */
  const captures = new Map<string, [number, number][]>();
  output.scenarios.forEach((scenario, si) => {
    scenario.steps.forEach((step, i) => {
      for (const id of step.criterionIds) {
        if (!known.has(id)) issues.push(`${at(si, i)}.criterionIds: unknown criterion id ${id} (valid ids: ${criterionIds.join(", ")})`);
      }
      // A value entered without a reference could only come from the model (D7): it must name the test
      // data key or secret it needs, so a missing one is blocked deterministically.
      if (step.kind === "fill" && !step.inputRef) {
        issues.push(`${at(si, i)}.inputRef: required when kind = fill (reference the test data key or secret name it enters)`);
      }
      if (step.kind !== "capture_checkpoint") return;
      if (!step.checkpoint) {
        issues.push(`${at(si, i)}.checkpoint: required when kind = capture_checkpoint`);
        return;
      }
      captures.set(step.checkpoint, [...(captures.get(step.checkpoint) ?? []), [si, i]]);
    });
    const logins = scenario.steps.flatMap((s, i) => (s.kind === "login" ? [at(si, i)] : []));
    if (logins.length > 1) {
      issues.push(`${logins.length} login steps (${logins.join(", ")}): at most one step per scenario may submit the credentials`);
    }
  });

  for (const [cp, where] of captures) {
    if (where.length > 1) {
      issues.push(`checkpoint ${cp} is captured more than once (${where.map(([si, i]) => at(si, i)).join(", ")}); capture it exactly once`);
    }
  }

  const required = new Set([...requirement.facts.map((f) => f.checkpoint), ...requirement.criteria.flatMap(neededCheckpoints)]);
  for (const cp of required) {
    if (!captures.has(cp)) {
      issues.push(`checkpoint ${cp} is never captured: add one capture_checkpoint step where its facts are visible`);
    }
  }

  for (const [before, after] of checkpointOrder(requirement.criteria)) {
    const b = captures.get(before)?.[0];
    const a = captures.get(after)?.[0];
    if (!b || !a) continue;
    if (b[0] !== a[0]) {
      issues.push(`checkpoints ${before} and ${after} must be captured in the same scenario (${at(...b)}, ${at(...a)})`);
    } else if (b[1] > a[1]) {
      issues.push(`checkpoint ${before} must be captured before ${after} (it is ${at(...b)}, ${after} is ${at(...a)})`);
    }
  }

  // Which scenario each criterion belongs to.
  const owner = new Map<string, number>();
  for (const c of requirement.criteria) {
    const where = [...new Set(neededCheckpoints(c).flatMap((cp) => (captures.get(cp) ? [captures.get(cp)![0]![0]] : [])))];
    if (where.length > 1) {
      issues.push(`${c.id} reads checkpoints captured in different scenarios (${where.map((si) => `scenarios.${si}`).join(", ")}): capture them in one scenario`);
      continue;
    }
    const named = output.scenarios.findIndex((s) => s.steps.some((step) => step.criterionIds.includes(c.id)));
    owner.set(c.id, where[0] ?? (named >= 0 ? named : 0));
  }
  if (output.scenarios.length > 1) {
    output.scenarios.forEach((_, si) => {
      if (![...owner.values()].includes(si)) issues.push(`scenarios.${si} serves no criterion: merge it into another scenario or remove it`);
    });
  }

  if (issues.length > 0) return { ok: false, issues };

  const readAt = (cp: string) => requirement.criteria.filter((c) => neededCheckpoints(c).includes(cp)).map((c) => c.id);
  let n = 0;
  const scenarios = output.scenarios.map((scenario, si): ValidatedScenario => ({
    title: scenario.title,
    criterionIds: criterionIds.filter((id) => owner.get(id) === si),
    steps: scenario.steps.map((step): PlannedStep => {
      const isCapture = step.kind === "capture_checkpoint" && !!step.checkpoint;
      const ids = new Set([...step.criterionIds, ...(isCapture ? readAt(step.checkpoint!) : [])]);
      return {
        id: `PS-${++n}`,
        kind: step.kind,
        description: step.description,
        ...(step.inputRef ? { inputRef: step.inputRef } : {}),
        ...(isCapture ? { checkpoint: step.checkpoint! } : {}),
        criterionIds: criterionIds.filter((id) => ids.has(id)),
        destructive: step.destructive,
      };
    }),
  }));
  return { ok: true, scenarios };
}
