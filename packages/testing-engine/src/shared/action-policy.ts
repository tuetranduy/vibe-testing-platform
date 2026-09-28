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

/** A planned step is destructive when the planner flagged it or its own wording names a destructive action. */
export function isDestructiveStep(step: Pick<PlannedStep, "description" | "destructive">): boolean {
  return step.destructive || !assertActionAllowed({ instruction: step.description }, DENY).allowed;
}
