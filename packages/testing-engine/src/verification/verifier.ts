import {
  URL_FACT_KEY,
  factRefsOf,
  type AcceptanceCriterion,
  type BlockReason,
  type BlockedCriterion,
  type ExplorationStep,
  type ExplorationStopReason,
  type FactRef,
  type ObservedFact,
  type PlannedStep,
  type ProvisionalResult,
  type StatusReason,
  type TestPlan,
} from "@platform/contracts";
import { clip } from "./normalize";
import { describeExpected, evaluateRule, factLabel } from "./rules";

/**
 * Verification engine (Task 15): turns recorded facts into a provisional result per criterion.
 * Pure — no I/O, no model calls; the same input always gives the same result. Provenance
 * (DOM_VERIFIED / MODEL_EXTRACTED) does not affect the provisional status: reconciliation decides
 * what a PASS/FAIL is worth (Section 2.3), using the `factRefs` listed here.
 *
 * Decision order (first match wins):
 *  1. The criterion is in the plan's blocked criteria            → BLOCKED, that reason (detail as `actual`).
 *  2. An `authenticated` precondition, and the plan has no
 *     `login` step                                                → BLOCKED / PRECONDITION_NOT_MET.
 *  3. Login failed (Ruling R15): a `login` planned step whose golden
 *     exploration step is SUCCESS, but the next captured `url` fact
 *     after it (else that step's urlAfter) has the same origin+path
 *     as its urlBefore → BLOCKED / LOGIN_FAILED, for criteria with a
 *     checkpoint planned after the login step. A FAILED login step is
 *     not LOGIN_FAILED (Ruling R25); it falls through to 5.
 *  4. `semantic` outcome                                          → INCONCLUSIVE / AMBIGUOUS_CRITERION when the
 *                                                                   criterion has an ambiguity, else AI_JUDGED_ONLY (D3).
 *  5. A required fact was not recorded (never FAIL):
 *     - exploration ended on a BLOCKED_BY_POLICY step             → BLOCKED, that step's blockReason
 *                                                                   (TARGET_BLOCKED_BY_POLICY when it has none);
 *     - stopped early (STEP_LIMIT_REACHED / EXPLORATION_BUDGET_EXHAUSTED) → INCONCLUSIVE, that stop reason;
 *     - otherwise, incl. COMPLETED after a trailing FAILED step (R25) → INCONCLUSIVE / FACT_NOT_OBSERVED.
 *  6. Evaluate the rule                                           → PASS / FAIL. An invalid regex →
 *                                                                   INCONCLUSIVE / AMBIGUOUS_CRITERION; a value of the
 *                                                                   wrong type for the rule (e.g. null) →
 *                                                                   INCONCLUSIVE / FACT_NOT_OBSERVED, never FAIL.
 *
 * `expected` / `actual` are template-built and at most 1000 characters. They can quote recorded page
 * text, so the verify stage passes them through the run's redactor before they leave the engine.
 */
export interface VerifyCriterionInput {
  criterion: AcceptanceCriterion;
  facts: readonly ObservedFact[];
  /** The plan's blocked criteria (`plan.blockedCriteria`). */
  blocked: readonly BlockedCriterion[];
  steps: readonly ExplorationStep[];
  stopReason: ExplorationStopReason;
  /** Ruling R16: needed for "authenticated precondition with no login step" and login checks. */
  plan: TestPlan;
}

const refKey = (ref: FactRef) => `${ref.key}@${ref.checkpoint}`;

export function verifyCriterion(input: VerifyCriterionInput): ProvisionalResult {
  const { criterion, plan } = input;
  const outcome = criterion.expectedOutcome;
  const refs = factRefsOf(outcome).map(({ ref }) => ({ key: ref.key, checkpoint: ref.checkpoint }));
  const expected = clip(describeExpected(outcome));
  const result = (status: ProvisionalResult["status"], reason: StatusReason | null, actual: string | null): ProvisionalResult => ({
    criterionId: criterion.id,
    status,
    reason,
    factRefs: refs,
    expected,
    actual: actual === null ? null : clip(actual),
  });

  // 1. Blocked by the plan.
  const planBlock =
    input.blocked.find((b) => b.criterionId === criterion.id) ?? plan.blockedCriteria.find((b) => b.criterionId === criterion.id);
  if (planBlock) return result("BLOCKED", planBlock.reason, planBlock.detail);

  // 2. Authenticated precondition with no way to log in.
  const plannedSteps = plan.scenarios.flatMap((s) => s.steps);
  const authenticated = criterion.preconditions.find((p) => p.kind === "authenticated");
  if (authenticated && !plannedSteps.some((s) => s.kind === "login")) {
    return result("BLOCKED", "PRECONDITION_NOT_MET", `The plan has no login step for the precondition: ${authenticated.description}`);
  }

  // 3. Login ran but did not get past the login page.
  const steps = [...input.steps].sort((a, b) => a.index - b.index);
  const login = failedLogin(refs, plannedSteps, steps, input.facts);
  if (login) return result("BLOCKED", "LOGIN_FAILED", `Login step ${login.stepId} succeeded but the page stayed at ${login.page}`);

  // 4. Only a model could judge this one.
  if (outcome.kind === "semantic") {
    return { ...result("INCONCLUSIVE", criterion.ambiguity ? "AMBIGUOUS_CRITERION" : "AI_JUDGED_ONLY", null), factRefs: [] };
  }

  // 5. A required fact was never recorded.
  const byRef = new Map<string, ObservedFact>();
  for (const f of input.facts) byRef.set(refKey(f), f);
  const missing = [...new Set(refs.filter((r) => !byRef.has(refKey(r))).map(factLabel))];
  if (missing.length > 0) {
    const labels = missing.join(", ");
    const block = policyBlock(steps, input.stopReason);
    if (block) {
      return result("BLOCKED", block.reason, `Exploration was blocked by policy at ${block.at} (${block.reason}) before ${labels} was observed`);
    }
    if (input.stopReason === "STEP_LIMIT_REACHED" || input.stopReason === "EXPLORATION_BUDGET_EXHAUSTED") {
      return result("INCONCLUSIVE", input.stopReason, `Exploration stopped early (${input.stopReason}) before ${labels} was observed`);
    }
    const last = steps.at(-1);
    const why = last?.outcome === "FAILED" ? ` (exploration stopped after ${stepName(last)} failed)` : "";
    return result("INCONCLUSIVE", "FACT_NOT_OBSERVED", `Not observed: ${labels}${why}`);
  }

  // 6. Evaluate the rule over the recorded values.
  const r = evaluateRule(outcome, (ref) => byRef.get(refKey(ref))!.value);
  return result(r.status, r.reason, r.actual);
}

const stepName = (step: ExplorationStep) => step.plannedStepId ?? `step ${step.index}`;

/** The policy block exploration ended on, if any: its last step, else (stopReason says so) the last blocked step. */
function policyBlock(steps: readonly ExplorationStep[], stopReason: ExplorationStopReason): { reason: BlockReason; at: string } | null {
  const last = steps.at(-1);
  const blocked =
    last?.outcome === "BLOCKED_BY_POLICY"
      ? last
      : stopReason === "BLOCKED_BY_POLICY"
        ? steps.findLast((s) => s.outcome === "BLOCKED_BY_POLICY")
        : undefined;
  if (blocked) return { reason: blocked.blockReason ?? "TARGET_BLOCKED_BY_POLICY", at: stepName(blocked) };
  return stopReason === "BLOCKED_BY_POLICY" ? { reason: "TARGET_BLOCKED_BY_POLICY", at: "an unrecorded step" } : null;
}

/** Origin + path (no query or fragment, no trailing slash), or the raw string when it is not a URL. */
function pageOf(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${u.origin}${path}`;
  } catch {
    return url;
  }
}

/**
 * Ruling R15. For each `login` planned step that precedes one of the criterion's checkpoints in the
 * plan: its golden SUCCESS step, then the first `url` fact captured after it (else the step's own
 * urlAfter). Still on the login step's page (origin + path) → login failed.
 */
function failedLogin(
  refs: readonly FactRef[],
  plannedSteps: readonly PlannedStep[],
  steps: readonly ExplorationStep[],
  facts: readonly ObservedFact[],
): { stepId: string; page: string } | null {
  const checkpointAt = new Map<string, number>();
  plannedSteps.forEach((s, i) => {
    if (s.kind === "capture_checkpoint" && s.checkpoint && !checkpointAt.has(s.checkpoint)) checkpointAt.set(s.checkpoint, i);
  });
  const needed = refs.map((r) => checkpointAt.get(r.checkpoint)).filter((i): i is number => i !== undefined);
  const stepIndex = new Map(steps.map((s) => [s.id, s.index]));

  for (const [position, planned] of plannedSteps.entries()) {
    if (planned.kind !== "login" || !needed.some((i) => i > position)) continue;
    const executed = steps.findLast((s) => s.plannedStepId === planned.id && s.outcome === "SUCCESS" && s.onGoldenPath);
    if (!executed) continue; // not run, or FAILED (R25): not a login failure
    let next: { index: number; url: string } | null = null;
    for (const f of facts) {
      const at = stepIndex.get(f.stepId);
      if (f.key !== URL_FACT_KEY || typeof f.value !== "string" || at === undefined || at <= executed.index) continue;
      if (!next || at < next.index) next = { index: at, url: f.value };
    }
    const landed = pageOf(next?.url ?? executed.urlAfter);
    if (landed === pageOf(executed.urlBefore)) return { stepId: planned.id, page: landed };
  }
  return null;
}
