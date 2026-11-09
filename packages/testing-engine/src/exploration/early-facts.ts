import type { AcceptanceCriterion, FactRequest, ObservedFact } from "@platform/contracts";
import type { Page } from "playwright-core";
import { readFact } from "./fact-reader";
import { recordElement } from "./recorder";
import { namedFactSubject } from "./named-facts";

/** Read the literal the user asks a notification to show; model paraphrases are not the authority. */
function notificationLiteral(source: string): string | null {
  const named = /\b(?:popup|pop-up|toast|notification|alert|dialog|message)\s+(?:(?:that\s+(?:says|reads)|saying|reading|showing|(?:with\s+)?(?:the\s+)?(?:text|message))\s+)?([^\r\n]+?)\s+(?:(?:should|must|will)\s+(?:be\s+)?(?:displayed|shown|visible|appear)|(?:is|becomes)\s+(?:displayed|shown|visible))\b/i.exec(source)?.[1];
  const quoted = [...source.matchAll(/["“]([^"”]{3,200})["”]/g)].map((m) => m[1]!);
  const literal = named?.trim().replace(/^["'“‘]|["'”’]$/g, "") ?? (quoted.length === 1 ? quoted[0] : null);
  return literal && literal.length >= 3 && literal.length <= 200 ? literal : null;
}

const NOTIFICATION_WORD = /\b(?:popup|pop-up|toast|notification|alert|dialog|message)\b/i;

/**
 * Where a page shows notifications: alert / status / dialog roles, live regions and open dialogs. A string, run in the
 * page (no named inner functions: tsx's keepNames would wrap them in a `__name(...)` call the page doesn't define).
 * Returns the innermost visible ones with text, as [element, collapsed text]; the caller maps the elements.
 */
const NOTIFICATIONS_SCRIPT = String.raw`(() => {
  const all = Array.from(document.querySelectorAll('[role="alert"], [role="status"], [role="alertdialog"], [role="dialog"], [aria-live="polite"], [aria-live="assertive"], dialog[open]'));
  const shown = all.filter((el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none"
      && (el.innerText || "").replace(/\s+/g, " ").trim() !== "";
  });
  return shown.filter((el) => !shown.some((other) => other !== el && el.contains(other)));
})()`;

/** The texts of the notifications the page shows now (the baseline before an action; KI-059). */
export async function notificationTexts(page: Page): Promise<string[]> {
  const handles = await page.evaluateHandle(NOTIFICATIONS_SCRIPT);
  try {
    return await handles.evaluate((els) => (els as HTMLElement[]).map((el) => el.innerText.replace(/\s+/g, " ").trim()));
  } finally {
    await handles.dispose();
  }
}

/** How long a notification has, after the action, to appear (its request may answer just before it renders). */
const APPEAR_TIMEOUT_MS = 1_000;
const APPEAR_POLL_MS = 100;

/**
 * The one notification shown now that was not shown before the action (by its text), or null when there is none or
 * more than one. Waits up to APPEAR_TIMEOUT_MS for it. For a text read, the element inside it holding its message:
 * the notification less its buttons (a toast's "Close"), when one element holds all of that.
 */
async function newNotification(page: Page, before: readonly string[], mode: "visible" | "text") {
  const seen = new Set(before);
  const deadline = Date.now() + APPEAR_TIMEOUT_MS;
  for (;;) {
    const handles = await page.evaluateHandle(NOTIFICATIONS_SCRIPT);
    try {
      const index = await handles.evaluate((els, known) => {
        const fresh = (els as HTMLElement[]).map((el, i) => [i, el.innerText.replace(/\s+/g, " ").trim()] as const).filter(([, t]) => !known.includes(t));
        return fresh.length === 1 ? fresh[0]![0] : fresh.length > 1 ? -2 : -1;
      }, [...seen]);
      if (index === -2) return null;
      if (index >= 0) {
        return await handles.evaluateHandle((els, [i, textMode]) => {
          const el = (els as HTMLElement[])[i as number]!;
          if (!textMode || !el.querySelector('button, [role="button"]')) return el;
          const parts = Array.from(el.querySelectorAll("*")).filter((d) => d instanceof HTMLElement
            && !d.closest('button, [role="button"]') && !d.querySelector('button, [role="button"]')
            && d.innerText.replace(/\s+/g, " ").trim() !== "") as HTMLElement[];
          const longest = parts.sort((a, b) => b.innerText.length - a.innerText.length)[0];
          return longest ?? el;
        }, [index, mode === "text"] as const);
      }
    } finally {
      await handles.dispose();
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, APPEAR_POLL_MS));
  }
}

/**
 * Capture a notification while it is present, before model calls can outlast it. The literal the user asks it to show
 * finds it; without one, and given `before` (the notifications shown before the action), the one that appeared since
 * (KI-059: "Verify ADELAIDE 2 has been added to cart. popup displayed"). Never from the model.
 */
export async function captureEarlyNotificationFact(
  page: Page,
  request: FactRequest,
  criteria: readonly AcceptanceCriterion[],
  stepId: string,
  before?: readonly string[] | null,
): Promise<ObservedFact | null> {
  const subject = namedFactSubject(request.description);
  if ((subject && ['input', 'field', 'button', 'selector', 'control'].includes(subject.kind))
    || /\b(?:heading|input|field|button|selector)\b.*\b(?:inside|within|in)\b.*\b(?:dialog|popup|toast)\b/i.test(request.description)) return null;
  const checks = criteria.filter((c) => {
    const outcome = c.expectedOutcome;
    return ((outcome.kind === "visible" && request.valueType === "boolean")
      || (outcome.kind === "text_matches" && request.valueType === "string"))
      && outcome.fact.key === request.key && outcome.fact.checkpoint === request.checkpoint
      && (NOTIFICATION_WORD.test(c.sourceText) || NOTIFICATION_WORD.test(c.statement) || NOTIFICATION_WORD.test(request.description));
  });
  if (checks.length === 0) return null;
  // sourceText is a verbatim slice of the requirement, even when descriptions lose quotes or paraphrase it.
  const original = checks.flatMap((c) => { const literal = NOTIFICATION_WORD.test(c.sourceText) ? notificationLiteral(c.sourceText) : null; return literal ? [literal] : []; });
  const described = [...request.description.matchAll(/["“]([^"”]{3,200})["”]/g)].map((m) => m[1]!);
  const literals = [...new Set(original.length > 0 ? original : described)];
  if (literals.length === 0 && before) return captureNewNotification(page, request, stepId, before);
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

/** The notification that appeared since the action, read from the DOM (DOM_VERIFIED); null when there is not one. */
async function captureNewNotification(page: Page, request: FactRequest, stepId: string, before: readonly string[]): Promise<ObservedFact | null> {
  const mode = request.valueType === "boolean" ? "visible" : "text";
  const handle = await newNotification(page, before, mode);
  const element = handle?.asElement();
  if (!element) {
    await handle?.dispose();
    return null;
  }
  try {
    const ref = await recordElement(page, element);
    const reading = await readFact(page, ref, mode);
    if (!reading || (mode === "visible" ? reading.value !== true : typeof reading.value !== "string" || reading.value === "")) return null;
    return { key: request.key, checkpoint: request.checkpoint, stepId, value: reading.value, provenance: "DOM_VERIFIED", read: { element: ref, mode } };
  } finally {
    await element.dispose();
  }
}
