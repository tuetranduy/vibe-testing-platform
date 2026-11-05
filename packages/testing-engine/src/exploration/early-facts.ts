import type { AcceptanceCriterion, FactRequest, ObservedFact } from "@platform/contracts";
import type { Page } from "playwright-core";
import { readFact } from "./fact-reader";
import { recordElement } from "./recorder";

/** Read the literal the user asks a notification to show; model paraphrases are not the authority. */
function notificationLiteral(source: string): string | null {
  const named = /\b(?:popup|pop-up|toast|notification|alert|dialog|message)\s+(?:(?:that\s+(?:says|reads)|saying|reading|showing|(?:with\s+)?(?:the\s+)?(?:text|message))\s+)?([^\r\n]+?)\s+(?:(?:should|must|will)\s+(?:be\s+)?(?:displayed|shown|visible|appear)|(?:is|becomes)\s+(?:displayed|shown|visible))\b/i.exec(source)?.[1];
  const quoted = [...source.matchAll(/["“]([^"”]{3,200})["”]/g)].map((m) => m[1]!);
  const literal = named?.trim().replace(/^["'“‘]|["'”’]$/g, "") ?? (quoted.length === 1 ? quoted[0] : null);
  return literal && literal.length >= 3 && literal.length <= 200 ? literal : null;
}

/** Capture a named notification while it is present, before model calls can outlast it. */
export async function captureEarlyNotificationFact(
  page: Page,
  request: FactRequest,
  criteria: readonly AcceptanceCriterion[],
  stepId: string,
): Promise<ObservedFact | null> {
  const checks = criteria.filter((c) => {
    const outcome = c.expectedOutcome;
    return ((outcome.kind === "visible" && request.valueType === "boolean")
      || (outcome.kind === "text_matches" && request.valueType === "string"))
      && outcome.fact.key === request.key && outcome.fact.checkpoint === request.checkpoint
      && /\b(?:popup|pop-up|toast|notification|alert|dialog|message)\b/i.test(c.sourceText);
  });
  if (checks.length === 0) return null;
  // sourceText is a verbatim slice of the requirement, even when descriptions lose quotes or paraphrase it.
  const original = checks.flatMap((c) => { const literal = notificationLiteral(c.sourceText); return literal ? [literal] : []; });
  const described = [...request.description.matchAll(/["“]([^"”]{3,200})["”]/g)].map((m) => m[1]!);
  const literals = [...new Set(original.length > 0 ? original : described)];
  if (literals.length !== 1) return null;
  const locator = page.getByText(literals[0]!, { exact: true }).filter({ visible: true });
  // The action's network can finish just before React commits the notification to the DOM.
  try {
    await locator.waitFor({ state: "visible", timeout: 1000 });
  } catch {
    return null;
  }
  if (await locator.count() !== 1) return null;
  // A matching product title or ordinary paragraph is not evidence of a popup/notification.
  if (!await locator.evaluate((el) => Boolean(el.closest('[role="alert"], [role="status"], [role="dialog"], [role="alertdialog"], [aria-live="polite"], [aria-live="assertive"]')))) return null;
  const handle = await locator.elementHandle();
  if (!handle) return null;
  try {
    const element = await recordElement(page, handle);
    const mode = request.valueType === "boolean" ? "visible" : "text";
    const reading = await readFact(page, element, mode);
    const expected = mode === "visible" ? true : literals[0]!.replace(/\s+/g, " ").trim();
    if (reading?.value !== expected) return null;
    return { key: request.key, checkpoint: request.checkpoint, stepId, value: reading.value, provenance: "DOM_VERIFIED", read: { element, mode } };
  } finally {
    await handle.dispose();
  }
}
