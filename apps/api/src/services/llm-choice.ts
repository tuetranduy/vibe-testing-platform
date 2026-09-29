import type { LlmChoice, LlmKeyProvider, LlmOverride, LlmProvider, ReasoningLevel } from "@platform/contracts";
import { MODEL_CATALOG, PROVIDER_LABELS, catalogModel, type CatalogModel } from "@platform/llm/catalog";

/** Which models this deployment can run now. */
export interface LlmAvailability {
  /** A key is saved in Settings or set in the environment (the API shares the worker's LLM_* variables). */
  keys: Record<LlmKeyProvider, boolean>;
  /** The fake engine is offered: NODE_ENV is not production. */
  fakeAllowed: boolean;
}

export type IssuePath = (string | number)[];
export interface ChoiceIssue {
  path: IssuePath;
  message: string;
}
export type ChoiceResult = { ok: true; choice: LlmChoice } | { ok: false; issue: ChoiceIssue };

/** The catalog as this deployment offers it: the fake engine only outside production. */
export function offeredModels(a: LlmAvailability): CatalogModel[] {
  return MODEL_CATALOG.filter((m) => m.provider !== "fake" || a.fakeAllowed);
}

/** A model of this provider can run now: its key exists (the fake engine: it is offered). */
export function providerAvailable(provider: LlmProvider, a: LlmAvailability): boolean {
  return provider === "fake" ? a.fakeAllowed : a.keys[provider];
}

/** The fix for a missing key, in the words the UI uses: "Add an Anthropic API key in Settings". */
export function addKeyHint(provider: LlmKeyProvider): string {
  return `Add ${provider === "anthropic" ? "an" : "a"} ${PROVIDER_LABELS[provider]} API key in Settings`;
}

const fail = (path: IssuePath, message: string): ChoiceResult => ({ ok: false, issue: { path, message } });
const levelsOf = (m: CatalogModel) => m.reasoningLevels.join(", ");

/**
 * A model a client names (a run's `llm.model`, or the defaults saved in Settings): it must be offered here, its
 * provider must have a key, and `reasoning` must be one of its levels. Issues are reported at `at.model` /
 * `at.reasoning`.
 */
export function checkModel(
  model: string,
  reasoning: ReasoningLevel,
  a: LlmAvailability,
  at: { model: IssuePath; reasoning: IssuePath },
): ChoiceResult {
  const m = offeredModels(a).find((o) => o.id === model);
  if (!m) return fail(at.model, `${model} is not a model offered here: choose one from the list`);
  if (m.provider !== "fake" && !a.keys[m.provider]) return fail(at.model, addKeyHint(m.provider));
  if (!m.reasoningLevels.includes(reasoning)) {
    return fail(at.reasoning, `${m.label} takes the reasoning levels ${levelsOf(m)}, not ${reasoning}`);
  }
  return { ok: true, choice: { provider: m.provider, model: m.id, reasoning } };
}

/**
 * The model choice a new run records (spec section 4), in order: the request's `llm.model` (with
 * `llm.reasoning`, default `default`); else the defaults saved in Settings (a request's `llm.reasoning` alone
 * may override their level when their model takes it); else the environment's (resolveEnvLlmChoice: a model
 * outside the catalog is accepted as the operator configured it). The chosen provider needs a key (the fake
 * engine none). Issues: `["llm", "model"]` / `["llm", "reasoning"]` for the request's own fields, `["llm"]`
 * when the defaults are at fault.
 */
export function resolveRunLlm(input: {
  override: LlmOverride | undefined;
  saved: { model: string; reasoning: ReasoningLevel } | null;
  env: LlmChoice;
  availability: LlmAvailability;
}): ChoiceResult {
  const { override, saved, env, availability: a } = input;
  if (override?.model) {
    return checkModel(override.model, override.reasoning ?? "default", a, { model: ["llm", "model"], reasoning: ["llm", "reasoning"] });
  }
  if (saved) {
    const m = offeredModels(a).find((o) => o.id === saved.model);
    if (!m) return fail(["llm"], `The default model in Settings (${saved.model}) is no longer offered: choose another in Settings`);
    return withDefaults({ provider: m.provider, model: m.id, reasoning: saved.reasoning }, m, override?.reasoning, a);
  }
  return withDefaults(env, catalogModel(env.model), override?.reasoning, a);
}

/** The defaults (saved or the environment's), with a request's own `llm.reasoning` when it gives one. */
function withDefaults(base: LlmChoice, model: CatalogModel | undefined, reasoning: ReasoningLevel | undefined, a: LlmAvailability): ChoiceResult {
  if (!providerAvailable(base.provider, a)) {
    return fail(
      ["llm"],
      base.provider === "fake"
        ? "The fake engine is not offered here: choose a default model in Settings"
        : `${addKeyHint(base.provider)}: the default model (${model?.label ?? base.model}) needs it`,
    );
  }
  if (reasoning === undefined) return { ok: true, choice: base };
  // An environment model outside the catalog takes only its own default level.
  if (reasoning !== "default" && !model?.reasoningLevels.includes(reasoning)) {
    return fail(
      ["llm", "reasoning"],
      model ? `${model.label} takes the reasoning levels ${levelsOf(model)}, not ${reasoning}` : `The default model (${base.model}) takes only its default reasoning level`,
    );
  }
  return { ok: true, choice: { ...base, reasoning } };
}
