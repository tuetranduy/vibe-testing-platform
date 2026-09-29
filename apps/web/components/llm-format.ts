import type { LlmProvider, LlmSettingsView, ReasoningLevel, TestRunSummary } from "@platform/contracts";

export type CatalogEntry = LlmSettingsView["models"][number];

/** A reasoning level other than the model's default, as the selects show it. */
export const LEVEL_LABEL: Record<Exclude<ReasoningLevel, "default">, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** The first reasoning option: what "default" means for this model ("Model default (high)"). */
export function modelDefaultLabel(model: Pick<CatalogEntry, "defaultLevel"> | undefined): string {
  if (!model) return "Model default";
  return `Model default (${model.defaultLevel ?? "no reasoning"})`;
}

/** How a run's model reads on the run page and in the report: "Claude Sonnet 5 · medium reasoning". */
export function llmChoiceText(llm: NonNullable<TestRunSummary["llm"]>): string {
  return `${llm.label} · ${llm.reasoning === "default" ? "model default" : `${llm.reasoning} reasoning`}`;
}

/** "$2.00 input · $10.00 output per million tokens". */
export function priceText(price: CatalogEntry["price"]): string {
  if (!price) return "No price on record for this model";
  return `$${price.inputUsdPerMTok.toFixed(2)} input · $${price.outputUsdPerMTok.toFixed(2)} output per million tokens`;
}

const GROUPS: readonly (readonly [LlmProvider, string])[] = [
  ["anthropic", "Anthropic"],
  ["gemini", "Google Gemini"],
  ["fake", "Development"],
];

/** The offered models by provider, in catalog order: Anthropic, Google Gemini, then Development (the fake engine) when offered. */
export function modelGroups(models: readonly CatalogEntry[]): { provider: LlmProvider; label: string; models: CatalogEntry[] }[] {
  return GROUPS.map(([provider, label]) => ({ provider, label, models: models.filter((m) => m.provider === provider) })).filter((g) => g.models.length > 0);
}
