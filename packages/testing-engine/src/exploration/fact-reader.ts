/// <reference lib="dom" />
import { URL_FACT_KEY, type ElementRef, type FactRequest, type FactValue, type ObservedFact } from "@platform/contracts";
import type { Page } from "playwright-core";
import { factValuesEqual, parseNumber } from "../shared/fact-values";
import { resolveElement } from "./recorder";

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
 * - text_list: whitespace-collapsed visible text of each child element, empty ones dropped
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
export async function readFact(page: Page, element: ElementRef, mode: FactReadMode): Promise<{ value: FactValue; element: ElementRef } | null> {
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
      const items = await locator.evaluate((el) => {
        const children = Array.from(el.children);
        const texts = children.length > 0
          ? children.map((c) => (c instanceof HTMLElement ? c.innerText : (c.textContent ?? "")))
          : (el instanceof HTMLElement ? el.innerText : (el.textContent ?? "")).split("\n");
        return texts;
      });
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

/** Reads the DOM at the recorded element and applies the provenance rules. */
export async function captureFact(page: Page, input: FactCaptureInput): Promise<ObservedFact> {
  let dom: DomReading | null = null;
  const mode = input.mode;
  if (input.element && mode) {
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
