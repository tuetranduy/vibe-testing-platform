import type { LlmProvider, ReasoningLevel } from "@platform/contracts";

/**
 * The models the Settings page and the new-test form offer (spec 2026-09-28-llm-settings-design.md,
 * section 2). Plain data next to pricing.ts: every entry but the fake engine has a price (catalog.test.ts).
 * Levels are the providers' own (Anthropic effort levels; Google's thinking-level table, checked 2026-09-28;
 * DeepSeek's reasoning efforts, checked 2026-09-30: `minimal` turns thinking off, `medium` is not offered since
 * DeepSeek runs it as `high`).
 * Importable as `@platform/llm/catalog` without loading a provider SDK (the API uses it).
 */
export interface CatalogModel {
  provider: LlmProvider;
  id: string;
  label: string;
  /** The levels a run may choose; always starts with "default" (no reasoning parameter: the model's own). */
  reasoningLevels: ReasoningLevel[];
  /** What "default" means, for display; null: the model does not reason. */
  defaultLevel: "minimal" | "low" | "medium" | "high" | null;
  /** Anthropic's server-side refusal fallback (`fallbacks: "default"`) is requested for this model. */
  refusalFallback: boolean;
}

export const MODEL_CATALOG: readonly CatalogModel[] = [
  { provider: "anthropic", id: "claude-fable-5-1", label: "Claude Fable 5.1", reasoningLevels: ["default", "low", "medium", "high"], defaultLevel: "high", refusalFallback: true },
  { provider: "anthropic", id: "claude-opus-5-5", label: "Claude Opus 5.5", reasoningLevels: ["default", "low", "medium", "high"], defaultLevel: "medium", refusalFallback: true },
  { provider: "anthropic", id: "claude-sonnet-5", label: "Claude Sonnet 5", reasoningLevels: ["default", "low", "medium", "high"], defaultLevel: "high", refusalFallback: false },
  { provider: "anthropic", id: "claude-haiku-4-5", label: "Claude Haiku 4.5", reasoningLevels: ["default"], defaultLevel: null, refusalFallback: false },
  { provider: "gemini", id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", reasoningLevels: ["default", "low", "medium", "high"], defaultLevel: "medium", refusalFallback: false },
  { provider: "gemini", id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", reasoningLevels: ["default", "minimal", "low", "medium", "high"], defaultLevel: "medium", refusalFallback: false },
  { provider: "gemini", id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", reasoningLevels: ["default", "minimal", "low", "medium", "high"], defaultLevel: "minimal", refusalFallback: false },
  { provider: "gemini", id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)", reasoningLevels: ["default", "low", "medium", "high"], defaultLevel: "high", refusalFallback: false },
  { provider: "deepseek", id: "deepseek-flash", label: "DeepSeek Flash", reasoningLevels: ["default", "minimal", "low", "high"], defaultLevel: "high", refusalFallback: false },
  { provider: "deepseek", id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", reasoningLevels: ["default", "minimal", "low", "high"], defaultLevel: "high", refusalFallback: false },
  { provider: "fake", id: "fake", label: "Fake engine (development)", reasoningLevels: ["default"], defaultLevel: null, refusalFallback: false },
];

/** How the UI and messages name each provider. */
export const PROVIDER_LABELS: Readonly<Record<LlmProvider, string>> = {
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  deepseek: "DeepSeek",
  fake: "Development",
};

/** The catalog entry for a model id (exact match), if the platform offers it. */
export function catalogModel(id: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}
