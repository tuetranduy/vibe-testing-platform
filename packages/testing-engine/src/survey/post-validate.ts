import { SuggestionSchema, type Suggestion } from "@platform/contracts";
import { assertActionAllowed } from "@platform/security";
import type { SurveyOutput } from "./model-output";

export interface SuggestionValidation {
  /** The valid suggestions — exact duplicates dropped — numbered S-1… in order (at most 8). */
  suggestions: Suggestion[];
  /** What is wrong with the answer; sent back in the correction round (empty when it is fully valid). */
  issues: string[];
}

const MIN_SUGGESTIONS = 3;
const MAX_SUGGESTIONS = 8;
const WithoutId = SuggestionSchema.omit({ id: true });

/** The action policy's destructive terms (as `applyBlocking` checks a planned step's description). */
const readsDestructive = (text: string): boolean => !assertActionAllowed({ instruction: text }, { allowDestructive: false }).allowed;

/**
 * Deterministic post-validation of the model's suggestions (spec section 5, step 6): trims, checks
 * each against the contract (lengths, needs as secret names / test data keys), drops exact
 * duplicates, marks `destructive` when the model said so or the text has a destructive term, and
 * numbers them S-1…. Never trusts the model with ids.
 */
export function postValidateSuggestions(output: SurveyOutput): SuggestionValidation {
  const issues: string[] = [];
  const kept: Omit<Suggestion, "id">[] = [];
  const texts = new Set<string>();
  output.suggestions.forEach((raw, i) => {
    const requirement = raw.requirement.trim();
    const parsed = WithoutId.safeParse({
      title: raw.title.trim(),
      requirement,
      why: raw.why.trim(),
      needs: {
        secrets: [...new Set(raw.needs.secrets.map((s) => s.trim()))],
        testData: [...new Set(raw.needs.testData.map((k) => k.trim()))],
      },
      destructive: raw.destructive || readsDestructive(requirement),
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) issues.push(`suggestions.${i}.${issue.path.map(String).join(".")}: ${issue.message}`);
      return;
    }
    if (texts.has(requirement)) return; // an exact duplicate is dropped, never a reason to ask again
    texts.add(requirement);
    kept.push(parsed.data);
  });
  if (kept.length < MIN_SUGGESTIONS) issues.push(`suggestions: propose at least ${MIN_SUGGESTIONS} different valid tests (${kept.length} usable)`);
  if (kept.length > MAX_SUGGESTIONS) issues.push(`suggestions: propose at most ${MAX_SUGGESTIONS} tests (got ${kept.length})`);
  return { suggestions: kept.slice(0, MAX_SUGGESTIONS).map((s, i) => ({ ...s, id: `S-${i + 1}` })), issues };
}
