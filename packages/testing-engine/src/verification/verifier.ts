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
 *     A text check whose test data key was not resolved (the run
 *     has no value for it; see resolveTestDataValues)            → BLOCKED / MISSING_TEST_DATA.
 *  2. An `authenticated` precondition, and the plan has no
 *     `login` step                                                → BLOCKED / PRECONDITION_NOT_MET.
 *  3. Login failed (Ruling R15): a `login` planned step whose golden
 *     exploration step is SUCCESS, but the next captured `url` fact
 *     after it (else that step's urlAfter) has the same origin+path
 *     as its urlBefore → BLOCKED / LOGIN_FAILED, for criteria with a
 *     checkpoint planned after the login step. A FAILED login step is
 *     not LOGIN_FAILED (Ruling R25); it falls through to 5.
 *  4. `semantic` outcome (2026-10-07, replaces D3): its latest SUCCESS `judge` step's judgment of what the page
 *     showed → PASS (relevant, HOLDS) / FAIL (relevant, DOES_NOT_HOLD), `aiJudged`, the observed result as `actual`.
 *     No judgment, or one that could not decide (not relevant, CANNOT_TELL) → INCONCLUSIVE / AMBIGUOUS_CRITERION
 *     when the criterion has an ambiguity, else AI_JUDGED_ONLY.
 *  5. A required fact was not recorded (never FAIL):
 *     - exploration ended on a BLOCKED_BY_POLICY step             → BLOCKED, that step's blockReason
 *                                                                   (TARGET_BLOCKED_BY_POLICY when it has none);
 *     - stopped early (STEP_LIMIT_REACHED / EXPLORATION_BUDGET_EXHAUSTED) → INCONCLUSIVE, that stop reason;
 *     - otherwise, incl. COMPLETED after a trailing FAILED step (R25) → INCONCLUSIVE / FACT_NOT_OBSERVED.
 *  3b. (after 4–6) A FAIL or INCONCLUSIVE result, no `authenticated` precondition, and a golden `act` before one of
 *     the criterion's checkpoints opened a sign-in prompt (KI-073)  → BLOCKED / SIGN_IN_REQUIRED.
 *  6b. (after 3b) A FAIL or INCONCLUSIVE result whose checkpoint was taken on the site's server error page (KI-074)
 *     → INCONCLUSIVE / SITE_ERROR.
 *  6. Evaluate the rule                                           → PASS / FAIL. In a numeric_delta or a comparison
 *                                                                   of explicitly named counters, a counter
 *                                                                   read from the page showing no number counts as 0
 *                                                                   (KI-060). An invalid regex →
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
  const result = decide(input);
  if (result.status !== "FAIL" && result.status !== "INCONCLUSIVE") return result;
  // 3b. A click on the way opened the site's sign-in prompt (KI-073): the check needs a signed-in user.
  const prompt = input.criterion.preconditions.some((p) => p.kind === "authenticated") ? null : signInPromptBefore(input.criterion.id, result.factRefs, input.plan, input.steps);
  if (prompt) return { ...result, status: "BLOCKED", reason: "SIGN_IN_REQUIRED", actual: `Step ${prompt} opened a sign-in prompt: the site asks to sign in for this action` };
  // 6b. One of its checkpoints was taken on the site's server error page (KI-074).
  const siteError = siteErrorAt(result.factRefs, input.plan, input.steps, input.facts);
  if (siteError) return { ...result, status: "INCONCLUSIVE", reason: "SITE_ERROR", actual: clip(`The site showed an error page (${siteError})`) };
  return result;
}

function decide(input: VerifyCriterionInput): ProvisionalResult {
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
  if (outcome.kind === "text_matches" && outcome.match.testDataKey !== undefined) {
    return result("BLOCKED", "MISSING_TEST_DATA", `The test data value "${outcome.match.testDataKey}" was not provided`);
  }

  // 2. Authenticated precondition with no way to log in.
  const plannedSteps = plan.scenarios.flatMap((s) => s.steps);
  const authenticated = criterion.preconditions.find((p) => p.kind === "authenticated");
  if (authenticated && !plannedSteps.some((s) => s.kind === "login")) {
    return result("BLOCKED", "PRECONDITION_NOT_MET", `The plan has no login step for the precondition: ${authenticated.description}`);
  }

  // 3. Login ran but did not get past the login page.
  const steps = [...input.steps].sort((a, b) => a.index - b.index);
  // A criterion about a rejected login (a wrong password shows an error) expects the page to stay: not a failure here.
  const login = expectsRejectedLogin(criterion) ? null : failedLogin(refs, plannedSteps, steps, input.facts);
  if (login) return result("BLOCKED", "LOGIN_FAILED", `Login step ${login.stepId} succeeded but the page stayed at ${login.page}`);

  // 4. Only a model could judge this one: from what the exploration saw.
  if (outcome.kind === "semantic") {
    const judgment = steps.findLast((s) => s.kind === "judge" && s.outcome === "SUCCESS" && s.judgment?.criterionId === criterion.id)?.judgment;
    if (judgment?.relevant && judgment.verdict !== "CANNOT_TELL") {
      return { ...result(judgment.verdict === "HOLDS" ? "PASS" : "FAIL", null, judgment.observed), factRefs: [], aiJudged: true };
    }
    const actual = !judgment ? null : judgment.relevant ? judgment.observed : `The page did not show it: ${judgment.observed}`;
    return { ...result("INCONCLUSIVE", criterion.ambiguity ? "AMBIGUOUS_CRITERION" : "AI_JUDGED_ONLY", actual), factRefs: [] };
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
  const r = evaluateRule(outcome, (ref) => byRef.get(refKey(ref))!.value, (ref) => showsNoNumber(byRef.get(refKey(ref))!));
  return result(r.status, r.reason, r.actual);
}

/**
 * A number read from the DOM, on the one element located for it, that showed no number, and the model agreed nothing
 * was shown (DOM_VERIFIED null): an empty counter (KI-060). The generated test reads it the same way (readNumberOrZero).
 */
function showsNoNumber(fact: ObservedFact): boolean {
  return fact.value === null && fact.provenance === "DOM_VERIFIED" && fact.read?.mode === "number";
}

/**
 * The planned step whose golden click opened a sign-in prompt (KI-073) before one of these checkpoints in its scenario's
 * plan (any, for a criterion that reads no fact), or null. Only a step that serves this criterion, or names none.
 */
function signInPromptBefore(criterionId: string, refs: readonly FactRef[], plan: TestPlan, steps: readonly ExplorationStep[]): string | null {
  for (const scenario of plan.scenarios) {
    const position = new Map(scenario.steps.map((s, i) => [s.id, i]));
    // A step that serves other criteria only ("Add to wishlist" for the wishlist check) does not block this one.
    const serves = new Map(scenario.steps.map((s) => [s.id, s.criterionIds.length === 0 || s.criterionIds.includes(criterionId)]));
    const checkpoints = scenario.steps.flatMap((s, i) => (s.kind === "capture_checkpoint" && refs.some((r) => r.checkpoint === s.checkpoint) ? [i] : []));
    if (refs.length > 0 && checkpoints.length === 0) continue;
    const last = refs.length > 0 ? Math.max(...checkpoints) : scenario.steps.length;
    const prompted = steps.find(
      (s) => s.kind === "act" && s.signInPrompt && s.onGoldenPath && s.plannedStepId !== null && serves.get(s.plannedStepId) === true && (position.get(s.plannedStepId) ?? Infinity) < last,
    );
    if (prompted) return prompted.plannedStepId;
  }
  return null;
}

/** The error heading of a checkpoint step these facts were (or were to be) captured at, taken on an error page (KI-074). */
function siteErrorAt(refs: readonly FactRef[], plan: TestPlan, steps: readonly ExplorationStep[], facts: readonly ObservedFact[]): string | null {
  const checkpoints = new Set(refs.map((r) => r.checkpoint));
  const captureIds = new Set(plan.scenarios.flatMap((s) => s.steps).filter((s) => s.kind === "capture_checkpoint" && checkpoints.has(s.checkpoint ?? "")).map((s) => s.id));
  const factSteps = new Set(facts.filter((f) => refs.some((r) => r.key === f.key && r.checkpoint === f.checkpoint)).map((f) => f.stepId));
  const at = steps.find((s) => s.kind === "checkpoint" && s.siteError && (factSteps.has(s.id) || (s.plannedStepId !== null && captureIds.has(s.plannedStepId))));
  return at?.siteError ?? null;
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
const LOGIN_WORDS = /\b(log\s*-?\s*in|logs\s+in|sign\s*-?\s*in|signs\s+in|signing\s+in|logging\s+in|password|credentials?)\b/i;
const REJECTED_WORDS = /\b(wrong|invalid|incorrect|bad|unknown|non-?existent|mismatch(?:ed)?|rejected|denied|refused|not\s+(?:be\s+)?(?:able|allowed|accepted)|cannot|can't|fails?|failed|error)\b/i;

/**
 * Whether the criterion checks that a login is rejected (e.g. "signing in with a wrong password shows an error"):
 * there the page staying at the login form is the expected outcome, so rule 3 (LOGIN_FAILED) does not apply and
 * the criterion's own facts decide it.
 */
export function expectsRejectedLogin(criterion: Pick<AcceptanceCriterion, "statement" | "sourceText">): boolean {
  return [criterion.statement, criterion.sourceText].some((t) => LOGIN_WORDS.test(t) && REJECTED_WORDS.test(t));
}

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
