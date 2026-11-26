import type { InputRef } from "@platform/contracts";

/** A field for an account's credentials or a person's details: a value typed there must have a name to be reused. */
const ACCOUNT_FIELD = /pass(?:word|phrase|code)|user ?name|log ?in|sign[- ]?(?:in|up)|e-?mail|account|full name|first name|last name|surname|phone/i;

const squash = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Why a fill step's literal value is refused, or null (2026-11-26): a literal is only for a value written in the
 * requirement. A made-up username, email, password or name typed as a literal has no name, so a later step (logging in
 * with the account just registered) cannot type it again; a test data key the model names is generated once and
 * reused by every step that references it. Never repeats the value.
 */
export function inventedValueIssue(
  step: { kind: string; description: string; inputRef?: InputRef | null },
  requirementText: string | undefined,
): string | null {
  const ref = step.inputRef;
  if (step.kind !== "fill" || ref?.source !== "literal" || requirementText === undefined) return null;
  if (!ACCOUNT_FIELD.test(step.description) || squash(requirementText).includes(squash(ref.key))) return null;
  return 'inputRef: a literal is only for a value written in the requirement. For an account\'s username, email, password or name, use a test data key you name (e.g. {"source":"testData","key":"new_account_password"}) and the same key wherever that value is typed again';
}
