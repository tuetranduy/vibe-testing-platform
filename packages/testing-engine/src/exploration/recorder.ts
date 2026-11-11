/// <reference lib="dom" />
import type { ElementRef, LocatorCandidate } from "@platform/contracts";
import type { ElementHandle, Locator, Page } from "playwright-core";
import { candidatesFromDescription, type ElementDescription } from "../shared/locator-policy";
import type { FieldFacts } from "./input-generator";

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

/**
 * Runs in the browser (`handle.evaluate`), so it must not declare a named inner function: tsx's
 * `keepNames` would wrap it in a `__name(...)` call the page doesn't define.
 */
function readDom(el: Element): DomFacts {
  const parts: string[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) {
    let i = 1;
    for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === n.localName) i++;
    parts.unshift(`${n.localName}[${i}]`);
  }
  const xpath = `/${parts.join("/")}`;
  const resolved = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  const field = el as HTMLInputElement;
  const labels = "labels" in field && field.labels ? Array.from(field.labels).map((l) => (l.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean) : [];
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

/**
 * What a field asks for, read from the DOM (no model): what a generated value must suit (2026-10-07). The label is the
 * field's own <label>, else its aria-label or aria-labelledby text; a select lists at most 50 options.
 */
export async function describeField(page: Page, target: ElementTarget, opts: RecorderOptions = {}): Promise<FieldFacts> {
  const handle = await resolveHandle(page, target, opts);
  return handle.evaluate(readField);
}

/** Runs in the page: no named inner functions (keepNames would wrap them in a helper the page lacks). */
function readField(el: Element): FieldFacts {
  const text: Record<string, string | null> = {};
  for (const name of ["type", "name", "placeholder", "autocomplete", "min", "max", "pattern", "aria-label"]) {
    const v = (el.getAttribute(name) ?? "").replace(/\s+/g, " ").trim();
    text[name] = v ? v.slice(0, 200) : null;
  }
  const field = el as HTMLInputElement;
  const own = (field.labels?.[0]?.textContent ?? "").replace(/\s+/g, " ").trim();
  const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
  const byIds = ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ").replace(/\s+/g, " ").trim();
  const label = own || text["aria-label"] || byIds || null;
  const tag = el.tagName.toLowerCase();
  const maxLength = el.hasAttribute("maxlength") ? Number(el.getAttribute("maxlength")) : NaN;
  const options =
    tag === "select"
      ? Array.from((el as HTMLSelectElement).options)
          // A disabled option cannot be chosen: selecting it throws, or leaves the select as it was.
          .filter((o) => !o.disabled && !(o.parentElement instanceof HTMLOptGroupElement && o.parentElement.disabled))
          .slice(0, 50)
          .map((o) => ({ value: o.value, label: (o.label || o.text).replace(/\s+/g, " ").trim() }))
      : [];
  return {
    tag,
    type: tag === "input" ? (text["type"] ?? "text") : null,
    name: text["name"] ?? null,
    label: label ? label.slice(0, 200) : null,
    placeholder: text["placeholder"] ?? null,
    autocomplete: text["autocomplete"] ?? null,
    maxLength: Number.isInteger(maxLength) && maxLength >= 0 ? maxLength : null,
    min: text["min"] ?? null,
    max: text["max"] ?? null,
    pattern: text["pattern"] ?? null,
    options,
  };
}

/**
 * What an element does when used, as one string (KI-032): its tag and type, where a link goes and where its form
 * posts (origin + path: never a query, which can carry personal data), and its form's method. Two elements with
 * the same locator but a different action — a link that now points elsewhere, a button moved into another form —
 * give different strings.
 */
export async function elementAction(page: Page, target: ElementTarget, opts: RecorderOptions = {}): Promise<string> {
  const handle = await resolveHandle(page, target, opts);
  // No named inner functions: tsx's keepNames would wrap them in a `__name(...)` call the page doesn't define.
  return handle.evaluate((el: Element) => {
    const form = (el as HTMLButtonElement).form ?? el.closest("form");
    const [href, posts] = [el.getAttribute("href"), form ? (el.getAttribute("formaction") ?? form.getAttribute("action") ?? document.baseURI) : null].map(
      (raw) => {
        if (!raw) return "";
        try {
          const u = new URL(raw, document.baseURI);
          return u.protocol === "http:" || u.protocol === "https:" ? `${u.origin}${u.pathname}` : u.protocol;
        } catch {
          return "?";
        }
      },
    );
    const method = form ? (el.getAttribute("formmethod") ?? form.getAttribute("method") ?? "get").toLowerCase() : "";
    return [el.localName, el.getAttribute("type") ?? "", href, posts, method].join("|");
  });
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
      return page.getByLabel(c.text, { exact: c.exact ?? true });
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

/**
 * Whether a click on the element would land on it (2026-11-06, R2): scrolled into view, its centre inside the viewport
 * and the topmost element there is it or inside it. A carousel's off-screen clone (clipped by `overflow: hidden`) or an
 * element under a fixed banner is not. One function, no named inner helpers (tsx's keepNames would break it).
 */
const HITTABLE = (el: Element): boolean => {
  el.scrollIntoView({ block: "center", inline: "nearest" });
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
  const top = document.elementFromPoint(x, y);
  return top !== null && (top === el || el.contains(top));
};

/** The element's positional XPath, as the explorer's selectors are written (`xpath=/html[1]/…`). */
const XPATH_OF = (el: Element): string => {
  const parts: string[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) {
    let i = 1;
    for (let p = n.previousElementSibling; p; p = p.previousElementSibling) if (p.tagName === n.tagName) i++;
    parts.unshift(`${n.tagName.toLowerCase()}[${i}]`);
  }
  return `xpath=/${parts.join("/")}`;
};

/** Whether a click on the selector's element would land on it (HITTABLE). True when it cannot be told. */
export async function isHittable(page: Page, selector: string): Promise<boolean> {
  const locator = page.locator(selector).first();
  return locator.evaluate(HITTABLE, undefined, { timeout: 2_000 }).catch(() => true);
}

/** At most this many elements per candidate are hit-tested for an alternative. */
const MAX_ALTERNATIVES = 20;

/**
 * Another element the recorded element's own non-positional candidates (role and name, test id, label, text) match
 * that a click would land on (R2): e.g. the visible copy of a product card's "Add to wishlist" button when the explorer
 * picked a carousel's off-screen clone. Its XPath selector, or null when there is none.
 */
export async function hittableAlternative(page: Page, ref: ElementRef): Promise<string | null> {
  for (const candidate of ref.candidates) {
    if (candidate.strategy === "xpath" || candidate.strategy === "css") continue;
    const found = await firstHittable(locatorFor(page, candidate));
    if (found) return found;
  }
  return null;
}

/** The XPath of the first of a locator's elements (at most MAX_ALTERNATIVES) a click would land on, or null. */
async function firstHittable(locator: Locator): Promise<string | null> {
  const n = Math.min(await countOf(locator), MAX_ALTERNATIVES);
  for (let i = 0; i < n; i++) {
    const el = locator.nth(i);
    if (!(await el.evaluate(HITTABLE, undefined, { timeout: 2_000 }).catch(() => false))) continue;
    const xpath = await el.evaluate(XPATH_OF, undefined, { timeout: 2_000 }).catch(() => null);
    if (xpath) return xpath;
  }
  return null;
}

/**
 * The first reachable element with one of these roles whose accessible name contains `name` (case-insensitive), e.g.
 * a product card's "Add to wishlist" button when the explorer returned the header's "wishlist" link (KI-072). Its
 * XPath selector, or null when the page has none.
 */
export async function reachableNamedControl(page: Page, name: string, roles: readonly string[]): Promise<string | null> {
  for (const role of roles) {
    const found = await firstHittable(page.getByRole(role as Parameters<Page["getByRole"]>[0], { name, exact: false }));
    if (found) return found;
  }
  return null;
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
 * must match exactly one element. Its error keeps the first line of Playwright's (the value is no longer masked).
 */
export async function fillElement(page: Page, target: ElementTarget, value: string, opts: RecorderOptions = {}): Promise<void> {
  const handle = await resolveHandle(page, target, opts);
  try {
    await handle.fill(value, { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  } catch (err) {
    const firstLine = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
    throw new Error(`recorder: fill failed: ${firstLine.slice(0, 300)}`);
  }
}

/**
 * What a filled field holds now: null when the selector no longer matches exactly one visible element, or the element
 * has no value to read (not an input, textarea or select). Reads only; never waits for the element.
 */
export async function fieldValue(page: Page, selector: string): Promise<string | null> {
  const locator = page.locator(selector);
  if ((await locator.count()) !== 1 || !(await locator.isVisible())) return null;
  return locator.inputValue({ timeout: 1_000 }).catch(() => null);
}

/** A required field of the form a click submits that is still empty (KI-062), and how to fill it. */
export interface RequiredField {
  /** `xpath=/html[1]/…`: the field's positional XPath (the recorder builds its replayable locator). */
  selector: string;
  how: "fill" | "select" | "check";
}

/** At most this many fields are completed in one form: a page is not a reason to fill a hundred inputs. */
export const MAX_REQUIRED_FIELDS = 20;

/**
 * The fields of the form `submit` belongs to (its `form`, else its closest `<form>`) that the form needs and are still
 * empty (KI-062): visible, enabled, writable, and required by `required`, `aria-required="true"` or a label with a "*".
 * A text field or textarea with no value → fill; a select on an empty or disabled placeholder option, with another option
 * to choose → select; an unchecked required checkbox, or the first radio of a required group with none checked → check.
 * `touched`: one of `typed` (selectors the run typed into since the last click) is in that form. No form: nothing.
 */
export async function requiredEmptyFields(page: Page, submit: string, typed: readonly string[]): Promise<{ touched: boolean; fields: RequiredField[] }> {
  const handle = await resolveHandle(page, submit, { timeoutMs: 1_000 });
  return handle.evaluate(scanForm, { typed: [...typed], max: MAX_REQUIRED_FIELDS });
}

/** Runs in the page: no named inner functions (keepNames would wrap them in a helper the page lacks). */
function scanForm(el: Element, args: { typed: string[]; max: number }): { touched: boolean; fields: RequiredField[] } {
  const own = (el as HTMLButtonElement).form ?? null;
  const form = own ?? el.closest("form");
  if (!form) return { touched: false, fields: [] };
  const typed: Element[] = [];
  for (const sel of args.typed) {
    try {
      const node = sel.startsWith("xpath=")
        ? document.evaluate(sel.slice(6), document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
        : document.querySelector(sel);
      if (node instanceof Element) typed.push(node);
    } catch {
      // a selector the page cannot evaluate: not in this form
    }
  }
  const controls = Array.from(form.elements) as (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[];
  const touched = typed.some((t) => controls.includes(t as HTMLInputElement) || form.contains(t));
  const fields: RequiredField[] = [];
  const radioGroups = new Set<string>();
  const skipTypes = new Set(["hidden", "submit", "button", "reset", "image", "file", "range", "color"]);
  for (const c of controls) {
    if (fields.length >= args.max) break;
    const tag = c.localName;
    if (tag !== "input" && tag !== "select" && tag !== "textarea") continue;
    const type = tag === "input" ? ((c as HTMLInputElement).type || "text").toLowerCase() : tag;
    if (skipTypes.has(type) || c.disabled || (c as HTMLInputElement).readOnly) continue;
    // Visible as Playwright sees it (a box and not visibility: hidden), so the fill and the generated test can act on it.
    const style = getComputedStyle(c);
    const rect = c.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0) || style.visibility === "hidden") continue;
    const label = c.labels?.[0] ?? null;
    const ids = (c.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
    const labelText = [label?.textContent ?? "", ...ids.map((id) => document.getElementById(id)?.textContent ?? "")].join(" ");
    const required = c.required || c.getAttribute("aria-required") === "true" || /\*/.test(labelText);
    if (!required) continue;
    const xpathParts: string[] = [];
    for (let n: Element | null = c; n; n = n.parentElement) {
      let i = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === n.localName) i++;
      xpathParts.unshift(`${n.localName}[${i}]`);
    }
    const selector = `xpath=/${xpathParts.join("/")}`;
    if (type === "checkbox") {
      if (!(c as HTMLInputElement).checked) fields.push({ selector, how: "check" });
    } else if (type === "radio") {
      const name = c.name;
      if (!name || radioGroups.has(name)) continue;
      radioGroups.add(name);
      const group = controls.filter((o) => o.localName === "input" && (o as HTMLInputElement).type === "radio" && o.name === name) as HTMLInputElement[];
      if (!group.some((o) => o.checked)) fields.push({ selector, how: "check" });
    } else if (tag === "select") {
      const s = c as HTMLSelectElement;
      const current = s.selectedIndex >= 0 ? s.options[s.selectedIndex] : null;
      const placeholder = !current || current.value === "" || current.disabled;
      const choice = Array.from(s.options).some((o) => o.value !== "" && !o.disabled);
      if (placeholder && choice) fields.push({ selector, how: "select" });
    } else if (c.value === "") {
      fields.push({ selector, how: "fill" });
    }
  }
  return { touched, fields };
}

/** Deterministic check of a checkbox or radio by our own code (KI-062). */
export async function checkElement(page: Page, target: ElementTarget, opts: RecorderOptions = {}): Promise<void> {
  const handle = await resolveHandle(page, target, opts);
  try {
    await handle.check({ timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  } catch (err) {
    const firstLine = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
    throw new Error(`recorder: check failed: ${firstLine.slice(0, 300)}`);
  }
}

/**
 * Deterministic `<select>` choice by our own code (the value comes from test data, a secret or the
 * requirement, never from the model). Matches an option by value or label.
 */
export async function selectElementOption(page: Page, target: ElementTarget, value: string, opts: RecorderOptions = {}): Promise<void> {
  const handle = await resolveHandle(page, target, opts);
  // A page can put the select back on its placeholder right after the change (KI-064: the Shopware register page's
  // first choice of a country is undone by its own re-render; a second one holds). Read it back after a moment and
  // choose again, a few times; a choice the page never keeps is an error, never a recorded success.
  for (let attempt = 1; ; attempt++) {
    let chosen: string[];
    try {
      chosen = await handle.selectOption(value, { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    } catch (err) {
      const firstLine = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
      throw new Error(`recorder: select failed: ${firstLine.slice(0, 300)}`);
    }
    await page.waitForTimeout(SELECT_SETTLE_MS);
    const now = await handle.evaluate((el) => (el as HTMLSelectElement).value).catch(() => null);
    if (now === null || chosen.includes(now)) return; // gone from the page (the next step decides), or kept
    if (attempt >= SELECT_ATTEMPTS) throw new Error(`recorder: select failed: the page did not keep the option (it shows "${now}")`);
  }
}

/** How long a chosen option must hold before it counts, and how many times it is chosen (KI-064). */
const SELECT_SETTLE_MS = 300;
const SELECT_ATTEMPTS = 3;
