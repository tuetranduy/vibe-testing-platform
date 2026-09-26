/// <reference lib="dom" />
import type { ElementRef, LocatorCandidate } from "@platform/contracts";
import type { ElementHandle, Locator, Page } from "playwright-core";
import { candidatesFromDescription, type ElementDescription } from "../shared/locator-policy";

/**
 * Recorder (Task 14): turns the element the explorer acted on (Stagehand's `xpath=/…` selector,
 * or any Playwright selector / handle) into replayable, ranked Playwright locator candidates
 * (spike Q3: XPath → DOM.describeNode backendNodeId → Accessibility.getPartialAXTree role/name,
 * plus DOM labels / placeholder / data-testid). Main frame only in V1 (`framePath: []`).
 */

/** A Playwright selector (Stagehand's `xpath=/html[1]/…` works as-is) or an element handle. */
export type ElementTarget = string | ElementHandle;

export interface RecorderOptions {
  /** How long to wait for a selector to attach. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

interface DomFacts {
  tag: string;
  id: string | null;
  nameAttr: string | null;
  placeholder: string | null;
  testId: string | null;
  labels: string[];
  text: string | null;
  xpath: string;
  xpathResolves: boolean;
}

async function resolveHandle(page: Page, target: ElementTarget, opts: RecorderOptions): Promise<ElementHandle> {
  if (typeof target !== "string") return target;
  const locator = page.locator(target);
  try {
    await locator.first().waitFor({ state: "attached", timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  } catch {
    // fall through to the count check for a uniform error
  }
  const count = await locator.count();
  if (count !== 1) throw new Error(`recorder: selector must match exactly one element (matched ${count})`);
  const handle = await locator.elementHandle({ timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  if (!handle) throw new Error("recorder: selector must match exactly one element (matched 0)");
  return handle;
}

function readDom(el: Element): DomFacts {
  const collapse = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const parts: string[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) {
    let i = 1;
    for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === n.localName) i++;
    parts.unshift(`${n.localName}[${i}]`);
  }
  const xpath = `/${parts.join("/")}`;
  const resolved = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  const field = el as HTMLInputElement;
  const labels = "labels" in field && field.labels ? Array.from(field.labels).map((l) => collapse(l.textContent)).filter(Boolean) : [];
  const text = el instanceof HTMLElement ? el.innerText : el.textContent;
  return {
    tag: el.localName,
    id: el.getAttribute("id"),
    nameAttr: el.getAttribute("name"),
    placeholder: el.getAttribute("placeholder"),
    testId: el.getAttribute("data-testid"),
    labels,
    text: text ? text.trim() : null,
    xpath,
    xpathResolves: resolved === el,
  };
}

/** DOM + accessibility facts about one element. */
export async function describeElement(page: Page, target: ElementTarget, opts: RecorderOptions = {}): Promise<ElementDescription> {
  const handle = await resolveHandle(page, target, opts);
  const frame = await handle.ownerFrame();
  if (frame !== page.mainFrame()) throw new Error("recorder: only main-frame elements are supported in V1");
  const dom = await handle.evaluate(readDom);
  if (!dom.xpathResolves) throw new Error("recorder: element is not addressable by XPath (shadow DOM?)");

  const cdp = await page.context().newCDPSession(page);
  let role: string | null = null;
  let name: string | null = null;
  try {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `document.evaluate(${JSON.stringify(dom.xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`,
    });
    if (!result.objectId) throw new Error("recorder: element vanished before it could be described");
    try {
      const { node } = await cdp.send("DOM.describeNode", { objectId: result.objectId });
      const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { backendNodeId: node.backendNodeId, fetchRelatives: false });
      const ax = nodes.find((n) => n.backendDOMNodeId === node.backendNodeId) ?? nodes[0];
      if (ax && !ax.ignored) {
        const r = ax.role?.value;
        const nm = ax.name?.value;
        role = typeof r === "string" && r ? r : null;
        name = typeof nm === "string" && nm.trim() ? nm.replace(/\s+/g, " ").trim() : null;
      }
    } finally {
      await cdp.send("Runtime.releaseObject", { objectId: result.objectId }).catch(() => {});
    }
  } finally {
    await cdp.detach().catch(() => {});
  }

  return {
    tag: dom.tag,
    role,
    name,
    labels: [...new Set(dom.labels)],
    placeholder: dom.placeholder,
    text: dom.text,
    testId: dom.testId,
    id: dom.id,
    nameAttr: dom.nameAttr,
    xpath: dom.xpath,
  };
}

/** The Playwright locator a candidate stands for (the same mapping the compiler emits, Task 16). */
export function locatorFor(page: Page, c: LocatorCandidate): Locator {
  switch (c.strategy) {
    case "role":
      return page.getByRole(c.role as Parameters<Page["getByRole"]>[0], { name: c.name, exact: c.exact });
    case "label":
      return page.getByLabel(c.text, { exact: true });
    case "placeholder":
      return page.getByPlaceholder(c.text, { exact: true });
    case "text":
      return page.getByText(c.text, { exact: c.exact });
    case "testId":
      return page.getByTestId(c.value);
    case "css":
      return page.locator(`css=${c.selector}`);
    case "xpath":
      return page.locator(`xpath=${c.selector}`);
  }
}

async function countOf(locator: Locator): Promise<number> {
  try {
    return await locator.count();
  } catch {
    return 0; // e.g. a role Playwright doesn't know
  }
}

/**
 * Records the acted element: ranked candidates, and `chosenIndex` = the first candidate that
 * matches exactly one element and that element is the acted one. The positional XPath always
 * qualifies, so a ref can always be built for a main-frame element.
 */
export async function recordElement(page: Page, target: ElementTarget, opts: RecorderOptions = {}): Promise<ElementRef> {
  const handle = await resolveHandle(page, target, opts);
  const description = await describeElement(page, handle, opts);
  const candidates = candidatesFromDescription(description);
  let chosenIndex = -1;
  for (let i = 0; i < candidates.length && chosenIndex < 0; i++) {
    const locator = locatorFor(page, candidates[i]!);
    if ((await countOf(locator)) !== 1) continue;
    const same = await locator.evaluate((el, target) => el === target, handle).catch(() => false);
    if (same) chosenIndex = i;
  }
  if (chosenIndex < 0) throw new Error("recorder: no candidate locates the acted element uniquely");
  return { candidates, chosenIndex, framePath: [] };
}

/**
 * Resolves a recorded element on the current page with its chosen candidate only: that is the
 * locator the generated test replays (Task 16), and falling back to another candidate (above all
 * the positional XPath) could silently read a different element after the DOM changed.
 * Returns the locator and how many elements it matches now.
 */
export async function resolveElement(page: Page, ref: ElementRef): Promise<{ locator: Locator; count: number }> {
  const candidate = ref.candidates[ref.chosenIndex];
  if (!candidate) throw new Error("recorder: chosenIndex out of range");
  const locator = locatorFor(page, candidate);
  return { locator, count: await countOf(locator) };
}

/**
 * Deterministic fill by our own code (D7: secrets are filled by us, never by the model). The target
 * must match exactly one element. The value is never logged or returned.
 */
export async function fillElement(page: Page, target: ElementTarget, value: string, opts: RecorderOptions = {}): Promise<void> {
  const handle = await resolveHandle(page, target, opts);
  try {
    await handle.fill(value, { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  } catch (err) {
    // Playwright error messages can echo call arguments; never let the value escape.
    const firstLine = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
    const safe = value ? firstLine.split(value).join("[REDACTED]") : firstLine;
    throw new Error(`recorder: fill failed: ${safe.slice(0, 300)}`);
  }
}

/**
 * Deterministic `<select>` choice by our own code (the value comes from test data, a secret or the
 * requirement, never from the model). Matches an option by value or label. Never logs the value.
 */
export async function selectElementOption(page: Page, target: ElementTarget, value: string, opts: RecorderOptions = {}): Promise<void> {
  const handle = await resolveHandle(page, target, opts);
  try {
    await handle.selectOption(value, { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  } catch (err) {
    const firstLine = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
    const safe = value ? firstLine.split(value).join("[REDACTED]") : firstLine;
    throw new Error(`recorder: select failed: ${safe.slice(0, 300)}`);
  }
}
