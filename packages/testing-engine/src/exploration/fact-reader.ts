/// <reference lib="dom" />
import { URL_FACT_KEY, type ElementRef, type FactRequest, type FactValue, type ObservedFact } from "@platform/contracts";
import type { Page } from "playwright-core";
import { factValuesEqual, parseNumber } from "../shared/fact-values";
import { recordElement, resolveElement } from "./recorder";

export { factValuesEqual, parseNumber } from "../shared/fact-values";

/**
 * Fact reader (Task 14): reads fact values from the DOM with a recorded, deterministic locator and
 * decides provenance (D2). A model-extracted value becomes DOM_VERIFIED only when the DOM reading
 * equals it after normalization; otherwise it stays MODEL_EXTRACTED and both values are kept.
 */

export type FactReadMode = NonNullable<ObservedFact["read"]>["mode"];

/**
 * Read semantics (the compiler must emit the same, Task 16):
 * - text: visible text (inputs: their value), whitespace-collapsed
 * - number: first number in that text (`"Cart (3)"` → 3)
 * - visible: whether the element is visible (gone → false)
 * - count: number of child elements (list items)
 * - value: form field value
 * - text_list: whitespace-collapsed visible text of each child element, empty ones dropped; with an
 *   item selector, the text of each child it matches, else of the first element it matches inside the child
 *   (children without one dropped)
 */

/**
 * Default DOM read mode for a requested value type, or null when there is none. Booleans have no
 * default (Ruling R24): "is disabled", "is checked", "is in stock" are not visibility, so a boolean
 * fact is DOM-read only in a mode the caller chooses explicitly ("visible" for facts behind a
 * `visible` expected outcome); otherwise it stays MODEL_EXTRACTED.
 */
export function modeForValueType(valueType: FactRequest["valueType"]): FactReadMode | null {
  switch (valueType) {
    case "number":
      return "number";
    case "boolean":
      return null;
    case "string_list":
      return "text_list";
    case "string":
      return "text";
  }
}

export interface DomReading {
  value: FactValue;
  read: NonNullable<ObservedFact["read"]>;
}

export interface FactReadingsInput {
  key: string;
  checkpoint: string;
  stepId: string;
  modelValue: FactValue;
  /** The DOM reading at the model-identified element, or null when no element could be located. */
  dom: DomReading | null;
}

/** Provenance rules (pure). The reserved `url` fact never comes from the model: use `urlFact`. */
export function factFromReadings(input: FactReadingsInput): ObservedFact {
  if (input.key === URL_FACT_KEY) throw new Error(`fact key "${URL_FACT_KEY}" is reserved; use urlFact()`);
  const base = { key: input.key, checkpoint: input.checkpoint, stepId: input.stepId };
  if (!input.dom) {
    return { ...base, value: input.modelValue, provenance: "MODEL_EXTRACTED", read: null, modelValue: input.modelValue };
  }
  if (factValuesEqual(input.modelValue, input.dom.value)) {
    return { ...base, value: input.dom.value, provenance: "DOM_VERIFIED", read: input.dom.read, modelValue: input.modelValue };
  }
  return {
    ...base,
    value: input.modelValue,
    provenance: "MODEL_EXTRACTED",
    read: input.dom.read,
    modelValue: input.modelValue,
    domValue: input.dom.value,
  };
}

/** The reserved `url` fact: read from the page itself, always DOM_VERIFIED. */
export function urlFact(page: Pick<Page, "url">, at: { checkpoint: string; stepId: string }): ObservedFact {
  return { key: URL_FACT_KEY, checkpoint: at.checkpoint, value: page.url(), provenance: "DOM_VERIFIED", read: null, stepId: at.stepId };
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Reads one value from the DOM with a recorded element's chosen (deterministic) locator. Null when
 * that locator does not match exactly one element, except `visible`, where no match reads false.
 */
export async function readFact(
  page: Page,
  element: ElementRef,
  mode: FactReadMode,
  itemSelector?: string,
): Promise<{ value: FactValue; element: ElementRef } | null> {
  const { locator, count } = await resolveElement(page, element);
  if (count !== 1) return mode === "visible" && count === 0 ? { value: false, element } : null;

  switch (mode) {
    case "visible":
      return { value: await locator.isVisible(), element };
    case "value":
      return { value: await locator.inputValue(), element };
    case "text":
    case "number": {
      const raw = await locator.evaluate((el) =>
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
          ? el.value
          : el instanceof HTMLElement
            ? el.innerText
            : (el.textContent ?? ""),
      );
      const text = collapse(raw);
      return { value: mode === "number" ? parseNumber(text) : text, element };
    }
    case "count":
      return { value: await locator.evaluate((el) => el.children.length), element };
    case "text_list": {
      const items = await locator.evaluate((el, sel) => {
        const children = Array.from(el.children);
        if (sel !== null) {
          return children
            .map((c) => (c.matches(sel) ? c : c.querySelector(sel)))
            .map((n) => (n === null ? "" : n instanceof HTMLElement ? n.innerText : (n.textContent ?? "")));
        }
        const texts = children.length > 0
          ? children.map((c) => (c instanceof HTMLElement ? c.innerText : (c.textContent ?? "")))
          : (el instanceof HTMLElement ? el.innerText : (el.textContent ?? "")).split("\n");
        return texts;
      }, itemSelector ?? null);
      return { value: items.map(collapse).filter(Boolean), element };
    }
  }
}

export interface FactCaptureInput {
  key: string;
  checkpoint: string;
  stepId: string;
  /** What the model extracted (MODEL_EXTRACTED until the DOM confirms it). */
  modelValue: FactValue;
  /** Where the model says the value is shown, recorded with `recordElement`; null if not located. */
  element: ElementRef | null;
  /** How to read it from the DOM, chosen by the caller; null = no deterministic read (MODEL_EXTRACTED). */
  mode: FactReadMode | null;
}

/** At most this many sub-element selectors are tried per list fact. */
const MAX_ITEM_SELECTORS = 12;

/**
 * Selectors for a sub-element of the list's rows whose text is one of the model's items (KI-001: rows like
 * `iPhone 17 Pro — Qty 1 — $1,199.00` where the model reports the name). Candidates only, best first (test
 * id, tag and classes, itemprop, tag): the caller keeps one only if reading it from every row gives exactly
 * the model's list, so exact matching still decides provenance.
 */
async function itemSelectorCandidates(page: Page, element: ElementRef, items: string[]): Promise<string[]> {
  const { locator, count } = await resolveElement(page, element);
  if (count !== 1) return [];
  // No named inner functions: tsx's keepNames would wrap them in a `__name(...)` call the page doesn't define.
  const tiers = await locator.evaluate((el, wanted) => {
    const keys = new Set(wanted.map((w) => w.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()));
    const out: string[][] = [[], [], [], []];
    for (const row of Array.from(el.children)) {
      // The row itself (a message in place of the list, e.g. an empty cart) or an element inside it.
      for (const d of [row, ...Array.from(row.querySelectorAll("*"))]) {
        const text = d instanceof HTMLElement ? d.innerText : (d.textContent ?? "");
        if (!keys.has(text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase())) continue;
        const testId = d.getAttribute("data-testid");
        const prop = d.getAttribute("itemprop");
        if (testId) out[0]!.push(`[data-testid="${CSS.escape(testId)}"]`);
        if (d.classList.length > 0) out[1]!.push(d.localName + Array.from(d.classList).map((c) => `.${CSS.escape(c)}`).join(""));
        if (prop) out[2]!.push(`[itemprop="${CSS.escape(prop)}"]`);
        out[3]!.push(d.localName);
      }
    }
    return out;
  }, items);
  return [...new Set(tiers.flat())].slice(0, MAX_ITEM_SELECTORS);
}

/**
 * The whole rows' texts when they equal the model's list; otherwise the first row sub-element whose texts
 * do. Null when neither can be read (not located, or not exactly one element).
 */
async function readList(page: Page, element: ElementRef, modelValue: FactValue): Promise<DomReading | null> {
  const whole = await readFact(page, element, "text_list");
  if (!whole) return null;
  const fallback: DomReading = { value: whole.value, read: { element: whole.element, mode: "text_list" } };
  if (!Array.isArray(modelValue) || modelValue.length === 0 || factValuesEqual(modelValue, whole.value)) return fallback;
  for (const itemSelector of await itemSelectorCandidates(page, element, modelValue)) {
    const reading = await readFact(page, element, "text_list", itemSelector);
    if (reading && factValuesEqual(modelValue, reading.value)) {
      return { value: reading.value, read: { element: reading.element, mode: "text_list", itemSelector } };
    }
  }
  return fallback;
}

/** How many levels up from the located element a text the model read may come from. */
const MAX_TEXT_ANCESTORS = 3;

/**
 * The located element's text when it equals the model's; otherwise the nearest ancestor (at most
 * MAX_TEXT_ANCESTORS up) whose whole text does, recorded as the fact's element (KI-001: the model reads
 * "Signed in as qa@demo.test" where the element it points at holds only the address). Exact (normalized) matching
 * still decides provenance. Null when the element cannot be read.
 */
async function readText(page: Page, element: ElementRef, modelValue: FactValue): Promise<DomReading | null> {
  const own = await readFact(page, element, "text");
  if (!own) return null;
  const reading: DomReading = { value: own.value, read: { element: own.element, mode: "text" } };
  if (typeof modelValue !== "string" || factValuesEqual(modelValue, own.value)) return reading;
  const { locator } = await resolveElement(page, element);
  const texts = await locator.evaluate((el, levels) => {
    const out: string[] = [];
    for (let node = el.parentElement; node && node !== document.body && out.length < levels; node = node.parentElement) out.push(node.innerText);
    return out;
  }, MAX_TEXT_ANCESTORS);
  const level = texts.findIndex((t) => factValuesEqual(modelValue, collapse(t)));
  if (level < 0) return reading;
  const handle = await locator.evaluateHandle((el, up) => {
    let node: Element = el;
    for (let i = 0; i <= up; i++) node = node.parentElement ?? node;
    return node;
  }, level);
  const ancestor = await recordElement(page, handle.asElement()!);
  const read = await readFact(page, ancestor, "text");
  return read && factValuesEqual(modelValue, read.value) ? { value: read.value, read: { element: read.element, mode: "text" } } : reading;
}

/** Reads the DOM at the recorded element and applies the provenance rules. */
export async function captureFact(page: Page, input: FactCaptureInput): Promise<ObservedFact> {
  let dom: DomReading | null = null;
  const mode = input.mode;
  if (input.element && mode === "text_list") {
    dom = await readList(page, input.element, input.modelValue).catch(() => null);
  } else if (input.element && mode === "text") {
    dom = await readText(page, input.element, input.modelValue).catch(() => null);
  } else if (input.element && mode) {
    const reading = await readFact(page, input.element, mode).catch(() => null);
    if (reading) dom = { value: reading.value, read: { element: reading.element, mode } };
  }
  return factFromReadings({ key: input.key, checkpoint: input.checkpoint, stepId: input.stepId, modelValue: input.modelValue, dom });
}

export interface CheckpointCaptureInput {
  checkpoint: string;
  stepId: string;
  facts: Omit<FactCaptureInput, "checkpoint" | "stepId">[];
}

/** All facts of one checkpoint: the reserved `url` fact first (always), then each requested fact. */
export async function captureCheckpoint(page: Page, input: CheckpointCaptureInput): Promise<ObservedFact[]> {
  const out: ObservedFact[] = [urlFact(page, input)];
  for (const f of input.facts) {
    out.push(await captureFact(page, { ...f, checkpoint: input.checkpoint, stepId: input.stepId }));
  }
  return out;
}
