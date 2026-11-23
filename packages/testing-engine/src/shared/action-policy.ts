import { destructiveActionsAllowed, type PlannedStep, type StoredTestRunRequest } from "@platform/contracts";
import { assertActionAllowed, type ActionPolicy } from "@platform/security";

/**
 * D9, amended 2026-09-28: destructive actions only when the run allows them — in production only with the
 * target host confirmed. The planner, the executor and the explore stage all decide with this.
 */
export function actionPolicyFor(request: Pick<StoredTestRunRequest, "targetUrl" | "environment" | "options">): ActionPolicy {
  return { allowDestructive: destructiveActionsAllowed(request) };
}

const DENY: ActionPolicy = { allowDestructive: false };

/**
 * Steps that only enter a value: typing, choosing an option or a search commits nothing by itself (the click or
 * submit that follows does, and is checked). The model's `destructive` flag on them is dropped: Flash flagged
 * "Select the purchased date" and, with destructive actions denied, cut a quote flow after 7 steps (KI-093). Their
 * wording is still checked against the policy's terms.
 */
const VALUE_ENTRY_KINDS: ReadonlySet<PlannedStep["kind"]> = new Set(["fill", "select", "search"]);

/** The `destructive` a planned step keeps from the model's flag. */
export function plannedDestructive(kind: PlannedStep["kind"], flagged: boolean): boolean {
  return flagged && !VALUE_ENTRY_KINDS.has(kind);
}

/** A planned step is destructive when the planner flagged it or its own wording names a destructive action. */
export function isDestructiveStep(step: Pick<PlannedStep, "description" | "destructive">): boolean {
  return step.destructive || !assertActionAllowed({ instruction: step.description }, DENY).allowed;
}
