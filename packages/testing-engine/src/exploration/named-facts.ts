/// <reference lib="dom" />
import type { ElementRef, FactRequest, ObservedFact } from '@platform/contracts';
import type { Page } from 'playwright-core';
import { readFact, type FactReadMode } from './fact-reader';
import { recordElement, resolveElement } from './recorder';

const normalize = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** A named subject, before its control noun. Qualifiers after the noun describe the checkpoint, not its name. */
export function namedFactSubject(description: string): { name: string; kind: string } | null {
  const text = description.replace(/^(?:whether|(?:current\s+)?value\s+of)\s+/i, '')
    .replace(/^(?:the|an?)\s+/i, '').replace(/^(?:header|static)\s+/i, '');
  const match = /^(.{1,80}?)\s+(?:text\s+)?(input|field|button|selector|control|dialog|product card|card|line)\b/i.exec(text);
  if (!match) return null;
  const name = match[1]!.replace(/^(?:product page|cart item)\s+/i, '').trim().replace(/^["'“‘]|["'”’]$/g, '');
  if (!name || /\b(?:whether|visible|shown|current|after|before|inside|any|some|unrelated|matching|selected|corresponding)\b/i.test(name)) return null;
  return { name, kind: match[2]!.toLowerCase() };
}

/**
 * Read controls by their label rather than asking the model to relocate their displayed value.
 * The query depends only on the requested subject, never its expected or extracted value.
 * Ambiguous subjects fall back to ordinary exploration. Absence has a real, replayable predicate.
 */
export async function captureNamedFact(page: Page, request: FactRequest, mode: FactReadMode, stepId: string): Promise<ObservedFact | null> {
  if (!['visible', 'text', 'number', 'value'].includes(mode)) return null;
  const subject = namedFactSubject(request.description);
  const field = subject && ['input', 'field', 'selector'].includes(subject.kind);
  const quantity = !subject && /\bquantity\b/i.test(request.description) && request.valueType === 'number';
  let element: ElementRef | null = null;
  if (field || quantity) {
    const wanted = normalize(subject?.name ?? request.description);
    const handles = await page.locator('input:not([type="hidden"]), textarea, select').elementHandles();
    const matches: { handle: (typeof handles)[number]; score: number }[] = [];
    try {
      for (const handle of handles) {
        const label = await handle.evaluate(el => {
          const input = el as HTMLInputElement;
          const node = el as Element;
          return Array.from(input.labels ?? []).map(l => l.textContent ?? '').join(' ').trim()
            || node.getAttribute('aria-label')
            || (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim()
            || '';
        });
        const name = normalize(label);
        if (!name || !(wanted === name || ` ${wanted} `.includes(` ${name} `))) continue;
        // A field inside a named dialog is not interchangeable with a similarly named background field.
        if (/\b(?:inside|within|in)\b.*\bdialog\b/i.test(request.description)
          && !await handle.evaluate(el => Boolean((el as Element).closest('[role="dialog"], dialog')))) continue;
        if (subject?.kind !== 'selector' && await handle.evaluate(el => (el as Element).tagName === 'SELECT')) continue;
        matches.push({ handle, score: name.length });
      }
      matches.sort((a, b) => b.score - a.score);
      if (matches.length && (matches.length === 1 || matches[0]!.score > matches[1]!.score)) {
        element = await recordElement(page, matches[0]!.handle);
      } else if (matches.length) return null;
    } finally {
      await Promise.all(handles.map(h => h.dispose()));
    }
    if (!element && mode === 'visible' && subject) {
      // Substring label matching also covers required markers, e.g. "Company *". When
      // another field contains that label, decline rather than claim the subject is absent.
      const locator = page.getByLabel(subject.name, { exact: false });
      if (await locator.count() !== 0) return null;
      element = { candidates: [{ strategy: 'label', text: subject.name, exact: false }], chosenIndex: 0, framePath: [] };
    }
  } else if (subject && mode === 'visible' && ['button', 'control'].includes(subject.kind)) {
    const scope = /\b(?:inside|within|in)\b.*\bdialog\b/i.test(request.description)
      ? page.getByRole('dialog') : page;
    const locator = scope.getByRole('button', { name: subject.name, exact: true });
    if (await locator.count() !== 1) return null;
    const handle = await locator.elementHandle();
    if (!handle) return null;
    try { element = await recordElement(page, handle); }
    finally { await handle.dispose(); }
  } else if (subject && mode === 'visible' && ['card', 'product card', 'line'].includes(subject.kind)) {
    const name = subject.name;
    const locator = page.getByText(name, { exact: true });
    const count = await locator.count();
    if (count > 1) return null;
    if (count === 1) {
      const handle = await locator.elementHandle();
      if (!handle) return null;
      try { element = await recordElement(page, handle); }
      finally { await handle.dispose(); }
    } else {
      element = { candidates: [{ strategy: 'text', text: name, exact: true }], chosenIndex: 0, framePath: [] };
    }
  } else if (subject?.kind === 'dialog' && mode === 'visible') {
    // No visible dialog at all proves the named dialog is gone. A visible dialog still needs a
    // subject-specific lookup: another modal is not evidence that this one is visible.
    const dialogs = page.locator('[role="dialog"], dialog');
    const count = await dialogs.count();
    if (count > 1 || (count === 1 && await dialogs.isVisible())) return null;
    element = { candidates: [{ strategy: 'css', selector: '[role="dialog"], dialog' }], chosenIndex: 0, framePath: [] };
  }
  if (!element) return null;
  const readMode = field && mode === 'text' ? 'value' : mode;
  // Resolve before reading: a query ambiguity must never turn into a negative visibility fact.
  const { count } = await resolveElement(page, element);
  if (count > 1 || (mode !== 'visible' && count !== 1)) return null;
  const reading = await readFact(page, element, readMode);
  if (!reading || reading.value === null) return null;
  return { key: request.key, checkpoint: request.checkpoint, stepId, value: reading.value,
    provenance: 'DOM_VERIFIED', read: { element: reading.element, mode: readMode } };
}
