import type { ExplorationStep, GeneratedInput } from "@platform/contracts";

/**
 * The values exploration generated because nobody provided them (2026-10-07): each `source:key` once, from the first
 * step (by index) whose `generatedValue` is set. Later fills of the same key reuse that value. Pure.
 */
export function generatedInputs(steps: readonly ExplorationStep[]): GeneratedInput[] {
  const seen = new Set<string>();
  const out: GeneratedInput[] = [];
  for (const step of [...steps].sort((a, b) => a.index - b.index)) {
    const ref = step.inputRef;
    if (step.generatedValue == null || !ref || ref.source === "literal") continue;
    const id = `${ref.source}:${ref.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ source: ref.source, key: ref.key, value: step.generatedValue, stepId: step.id });
  }
  return out;
}

/** The generated test data values, by key (generated secrets are left out). */
export function generatedTestData(steps: readonly ExplorationStep[]): Record<string, string> {
  return Object.fromEntries(generatedInputs(steps).filter((g) => g.source === "testData").map((g) => [g.key, g.value]));
}
