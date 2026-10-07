import type { StatusReason } from "./results";

/** One plain-language sentence for every BLOCKED and INCONCLUSIVE reason in the contracts (Section 2.2). */
export const STATUS_REASON_TEXT: Record<StatusReason, string> = {
  // BLOCKED
  MISSING_SECRET: "A secret this check needs (for example a password) was not provided",
  MISSING_TEST_DATA: "Test data this check needs was not provided",
  DESTRUCTIVE_ACTION_NOT_AUTHORIZED:
    "Checking it needs an action that could change or delete data, which this run's policy did not allow at that step",
  TARGET_BLOCKED_BY_POLICY: "The page it needs is not allowed by the network policy",
  OFF_DOMAIN_NAVIGATION: "Checking it would have meant leaving the allowed website",
  LOGIN_FAILED: "Logging in failed with the credentials provided",
  PRECONDITION_NOT_MET: "An earlier step it depends on could not be completed",
  // INCONCLUSIVE
  STEP_LIMIT_REACHED: "The run reached its step limit before this could be checked",
  EXPLORATION_BUDGET_EXHAUSTED: "Exploring the site ran out of time before this could be checked",
  FACT_NOT_OBSERVED: "The information needed to check this was not found on the page",
  UNVERIFIED_EVIDENCE: "The evidence was read by the AI model and could not be confirmed from the page itself",
  DISCOVERY_RERUN_DISAGREE: "Exploring the site and rerunning the generated test gave different results",
  AI_JUDGED_ONLY: "Only the AI can judge this, and what the page showed did not decide it",
  AMBIGUOUS_CRITERION: "The criterion was too ambiguous to check reliably",
  RERUN_NOT_REACHED: "The saved test stopped before it reached this check",
  NOT_IN_GENERATED_TEST: "The saved test has no check for this criterion, so a rerun cannot confirm it",
};
