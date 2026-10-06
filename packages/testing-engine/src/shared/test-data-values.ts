import type { AcceptanceCriterion, NormalizedRequirement, TestDataValue } from "@platform/contracts";

/**
 * A text check may compare with the run's value for a test data key (`match.testDataKey`, KI-001): the model only
 * ever sees keys. Before a check is evaluated (the verifier) or compiled (the Playwright test), the key is replaced
 * by that value, as text, so both read a literal `match.value` as before. A key the run has no value for (missing,
 * null or empty) stays unresolved: its criterion's `test_data` precondition blocks it (MISSING_TEST_DATA), and the
 * verifier blocks an unresolved check on its own too. Pure; the input is not changed.
 */
export function resolveTestDataValues<R extends Pick<NormalizedRequirement, "criteria">>(requirement: R, testData: Readonly<Record<string, TestDataValue>>): R {
  return { ...requirement, criteria: requirement.criteria.map((c) => resolveCriterion(c, testData)) };
}

function resolveCriterion(criterion: AcceptanceCriterion, testData: Readonly<Record<string, TestDataValue>>): AcceptanceCriterion {
  const outcome = criterion.expectedOutcome;
  if (outcome.kind !== "text_matches" || outcome.match.testDataKey === undefined) return criterion;
  const raw = Object.hasOwn(testData, outcome.match.testDataKey) ? testData[outcome.match.testDataKey] : undefined;
  if (raw === undefined || raw === null || String(raw) === "") return criterion;
  const { testDataKey: _key, ...match } = outcome.match;
  return { ...criterion, expectedOutcome: { ...outcome, match: { ...match, value: String(raw) } } };
}
