/**
 * Deterministic validation of the planner model's output against the confirmed requirement. Any
 * issue returned here is a model contract violation: it triggers the single correction round, then
 * ContractError. The model is never trusted with step ids, criterion ids or checkpoint coverage.
 */
import { factRefsOf, type AcceptanceCriterion, type FactRequest, type PlannedStep } from "@platform/contracts";
import type { PlannerOutput } from "./model-output";

export type PlanValidation = { ok: true; steps: PlannedStep[] } | { ok: false; issues: string[] };

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
 * Check the model output and assemble the steps: ids PS-1…n, null fields dropped, and each capture
 * step lists every criterion whose facts are read at its checkpoint (plus the ones the model named).
 * The `destructive` flag is the model's; the action policy is applied later (see blocking.ts).
 */
export function validatePlanOutput(
  output: PlannerOutput,
  requirement: { criteria: AcceptanceCriterion[]; facts: FactRequest[] },
): PlanValidation {
  const issues: string[] = [];
  const criterionIds = requirement.criteria.map((c) => c.id);
  const known = new Set(criterionIds);

  const captures = new Map<string, number[]>();
  output.steps.forEach((step, i) => {
    for (const id of step.criterionIds) {
      if (!known.has(id)) issues.push(`steps.${i}.criterionIds: unknown criterion id ${id} (valid ids: ${criterionIds.join(", ")})`);
    }
    // A value entered without a reference could only come from the model (D7): it must name the test
    // data key or secret it needs, so a missing one is blocked deterministically.
    if (step.kind === "fill" && !step.inputRef) {
      issues.push(`steps.${i}.inputRef: required when kind = fill (reference the test data key or secret name it enters)`);
    }
    if (step.kind !== "capture_checkpoint") return;
    if (!step.checkpoint) {
      issues.push(`steps.${i}.checkpoint: required when kind = capture_checkpoint`);
      return;
    }
    captures.set(step.checkpoint, [...(captures.get(step.checkpoint) ?? []), i]);
  });

  const logins = output.steps.flatMap((s, i) => (s.kind === "login" ? [`steps.${i}`] : []));
  if (logins.length > 1) {
    issues.push(`${logins.length} login steps (${logins.join(", ")}): at most one step may submit the credentials`);
  }

  for (const [cp, at] of captures) {
    if (at.length > 1) issues.push(`checkpoint ${cp} is captured more than once (${at.map((i) => `steps.${i}`).join(", ")}); capture it exactly once`);
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
    if (b !== undefined && a !== undefined && b > a) {
      issues.push(`checkpoint ${before} must be captured before ${after} (it is steps.${b}, ${after} is steps.${a})`);
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  const readAt = (cp: string) => requirement.criteria.filter((c) => neededCheckpoints(c).includes(cp)).map((c) => c.id);
  const steps = output.steps.map((step, i): PlannedStep => {
    const isCapture = step.kind === "capture_checkpoint" && !!step.checkpoint;
    const ids = new Set([...step.criterionIds, ...(isCapture ? readAt(step.checkpoint!) : [])]);
    return {
      id: `PS-${i + 1}`,
      kind: step.kind,
      description: step.description,
      ...(step.inputRef ? { inputRef: step.inputRef } : {}),
      ...(isCapture ? { checkpoint: step.checkpoint! } : {}),
      criterionIds: criterionIds.filter((id) => ids.has(id)),
      destructive: step.destructive,
    };
  });
  return { ok: true, steps };
}
