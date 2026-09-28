/**
 * Deterministic blocking: which criteria the run cannot check, decided by our code from the planned
 * steps — never by the model. Pure: no LLM, no I/O.
 *
 * A criterion *depends on* the steps up to and including the last `capture_checkpoint` step whose
 * checkpoint its facts read. A criterion without facts (`semantic`) depends on the steps up to the
 * last step that references it in `criterionIds`; if no step references it, it depends on the whole
 * scenario (erring toward blocking). Steps after that point never block it.
 *
 * Reason precedence (first match wins; the order of `BlockReason`):
 *   1. MISSING_SECRET — a secret precondition, or a dependent step's secret inputRef, is not provided;
 *   2. MISSING_TEST_DATA — the same for test data keys;
 *   3. DESTRUCTIVE_ACTION_NOT_AUTHORIZED — a dependent step is at or after the first step the action
 *      policy denies (the scenario is truncated before that step).
 * Missing inputs come first because the user can fix them by supplying the value; the policy is a
 * decision about the run itself.
 */
import type { AcceptanceCriterion, BlockedCriterion, PlannedStep } from "@platform/contracts";
import { assertActionAllowed, type ActionPolicy } from "@platform/security";
import { isDestructiveStep } from "../shared/action-policy";
import { neededCheckpoints } from "./post-validate";

export interface BlockingInput {
  criteria: AcceptanceCriterion[];
  /** Validated steps (see validatePlanOutput), in scenario order. */
  steps: PlannedStep[];
  targetUrl: string;
  testDataKeys: string[];
  secretNames: string[];
  policy: ActionPolicy;
}

export interface BlockingResult {
  /** The scenario's steps: truncated before the first disallowed step, never empty. */
  steps: PlannedStep[];
  blockedCriteria: BlockedCriterion[];
}

type Block = Omit<BlockedCriterion, "criterionId">;

const MAX_QUOTE = 150;
const quote = (text: string) => `"${text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE - 1)}…` : text}"`;
const NOT_AUTHORIZED = "destructive actions are not allowed for this run (allowDestructiveActions is off)";

export function applyBlocking(input: BlockingInput): BlockingResult {
  // A step is destructive if the model says so or the policy's terms match it. Checking the terms with
  // allowDestructive=false keeps the flag truthful when the run is allowed to perform it.
  const steps = input.steps.map((s) => ({ ...s, destructive: isDestructiveStep(s) }));
  const stop = firstDisallowed(input.steps, input.policy);

  const provided = { secret: new Set(input.secretNames), testData: new Set(input.testDataKeys) };
  const blockedCriteria: BlockedCriterion[] = [];
  for (const criterion of input.criteria) {
    const end = dependencyEnd(criterion, steps);
    const deps = steps.slice(0, end + 1);
    const block =
      missingInput(criterion, deps, "secret", provided.secret) ??
      missingInput(criterion, deps, "testData", provided.testData) ??
      (stop && end >= stop.index ? { reason: "DESTRUCTIVE_ACTION_NOT_AUTHORIZED" as const, detail: stop.detail } : null);
    if (block) blockedCriteria.push({ criterionId: criterion.id, reason: block.reason, detail: block.detail.slice(0, 500) });
  }

  const kept = stop ? steps.slice(0, stop.index) : steps;
  return { steps: kept.length > 0 ? kept : [openTarget(input.targetUrl)], blockedCriteria };
}

/**
 * Index of the last step the criterion depends on (-1: none), within the full (untruncated) scenario.
 * A criterion with no needed checkpoints that no step references depends on every step.
 */
export function dependencyEnd(criterion: AcceptanceCriterion, steps: PlannedStep[]): number {
  const needed = new Set(neededCheckpoints(criterion));
  let end = -1;
  steps.forEach((s, i) => {
    const relevant =
      needed.size > 0
        ? s.kind === "capture_checkpoint" && s.checkpoint !== undefined && needed.has(s.checkpoint)
        : s.criterionIds.includes(criterion.id);
    if (relevant) end = i;
  });
  if (end < 0 && needed.size === 0) return steps.length - 1;
  return end;
}

/**
 * The first step the policy denies. The model's `destructive: true` adds a denial when destructive
 * actions are not allowed; its `false` never overrides the policy's terms.
 */
function firstDisallowed(steps: PlannedStep[], policy: ActionPolicy): { index: number; detail: Block["detail"] } | null {
  for (const [index, step] of steps.entries()) {
    const decision = assertActionAllowed({ instruction: step.description }, policy);
    if (!decision.allowed) {
      return { index, detail: `${step.id} ${quote(step.description)} matches destructive term "${decision.matched}"; ${NOT_AUTHORIZED}` };
    }
    if (step.destructive && !policy.allowDestructive) {
      return { index, detail: `${step.id} ${quote(step.description)} was marked destructive by the planner; ${NOT_AUTHORIZED}` };
    }
  }
  return null;
}

function missingInput(
  criterion: AcceptanceCriterion,
  deps: PlannedStep[],
  source: "secret" | "testData",
  provided: Set<string>,
): Block | null {
  const reason = source === "secret" ? "MISSING_SECRET" : "MISSING_TEST_DATA";
  const what = source === "secret" ? "Secret" : "Test data key";
  const preconditionKind = source === "secret" ? "secret" : "test_data";

  for (const p of criterion.preconditions) {
    if (p.kind !== preconditionKind) continue;
    if (!p.ref) return { reason, detail: `A precondition needs a ${what.toLowerCase()} but names none: ${quote(p.description)}` };
    if (!provided.has(p.ref)) return { reason, detail: `${what} ${quote(p.ref)} was not provided (required by a precondition)` };
  }
  for (const step of deps) {
    if (step.inputRef?.source === source && !provided.has(step.inputRef.key)) {
      return { reason, detail: `${what} "${step.inputRef.key}" was not provided (used by ${step.id})` };
    }
  }
  return null;
}

/** The whole scenario was cut: keep a valid one-step plan (every dependent criterion is blocked). */
function openTarget(targetUrl: string): PlannedStep {
  return { id: "PS-1", kind: "navigate", description: `Open ${targetUrl}`.slice(0, 500), criterionIds: [], destructive: false };
}
