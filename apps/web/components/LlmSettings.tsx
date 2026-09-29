"use client";

import type { LlmKeyProvider, LlmSettingsView, ReasoningLevel } from "@platform/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { ApiRequestError, getLlmSettings, saveLlmDefaults, saveProviderKey } from "../lib/api";
import { Icon } from "./Icon";
import { LEVEL_LABEL, modelDefaultLabel, priceText } from "./llm-format";
import { ModelOptions } from "./ModelOptions";
import { formatWhen } from "./report-format";

type State = { status: "loading" } | { status: "ready"; view: LlmSettingsView } | { status: "error"; message: string };
type ProviderView = LlmSettingsView["providers"][number];

/** The server's environment variable for each provider's key. */
const ENV_VAR: Record<LlmKeyProvider, string> = { anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" };

const messageOf = (err: unknown, fallback: string) =>
  err instanceof ApiRequestError ? (err.issues?.[0]?.message ?? err.message) : err instanceof Error ? err.message : fallback;

/**
 * Settings → AI providers (a write-only key per provider) and the defaults for new tests
 * (spec 2026-09-28-llm-settings-design.md, section 7). Every save answers with the whole view, which
 * replaces the one shown.
 */
export function LlmSettings() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    getLlmSettings().then(
      (view) => live && setState({ status: "ready", view }),
      (err: unknown) => live && setState({ status: "error", message: messageOf(err, "Something went wrong.") }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  if (state.status === "loading") {
    return (
      <p className="muted" role="status">
        Loading settings…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <div role="alert" className="banner banner-error">
        <Icon name="warning" />
        <div>
          <p className="banner-title">Settings couldn&apos;t be loaded</p>
          <p>{state.message}</p>
          <div className="actions">
            <button type="button" className="button button-secondary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { view } = state;
  const show = (next: LlmSettingsView) => setState({ status: "ready", view: next });
  return (
    <div className="stack-lg">
      <section className="stack" aria-labelledby="providers-title">
        <div className="section-head">
          <h2 id="providers-title" className="section-title">
            AI providers
          </h2>
          <p className="muted">Keys are stored encrypted and never shown again. A key saved here is used instead of the server&apos;s.</p>
        </div>
        <div className="settings-grid">
          {view.providers.map((p) => (
            <ProviderKeyCard key={p.provider} provider={p} onSaved={show} />
          ))}
        </div>
      </section>
      <DefaultsForm view={view} onSaved={show} />
    </div>
  );
}

function ProviderKeyCard({ provider, onSaved }: { provider: ProviderView; onSaved: (view: LlmSettingsView) => void }) {
  const id = `key-${provider.provider}`;
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function send(apiKey: string | null) {
    setPending(true);
    setError(null);
    setNotice(null);
    // The key leaves the page as soon as the request is sent, whatever the answer (as new-test secrets do).
    setValue("");
    try {
      onSaved(await saveProviderKey(provider.provider, apiKey));
      setNotice(apiKey === null ? "Saved key removed." : "Key saved.");
      setConfirming(false);
    } catch (err) {
      setError(messageOf(err, "The key couldn't be saved. Please try again."));
    } finally {
      setPending(false);
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    if (!value.trim()) {
      setError("Enter the API key.");
      return;
    }
    void send(value);
  };

  const { key } = provider;
  return (
    <form className="card stack-tight" aria-labelledby={`${id}-title`} onSubmit={onSubmit} noValidate>
      <h3 id={`${id}-title`} className="card-title">
        {provider.label}
      </h3>
      <p className="key-status">
        {key.source === "settings" && key.updatedAt ? (
          <>
            <Icon name="check" /> <span>Key saved · updated {formatWhen(key.updatedAt)}</span>
          </>
        ) : key.source === "environment" ? (
          <>
            <Icon name="info" /> <span>Using the server&apos;s key (<code>{ENV_VAR[provider.provider]}</code>)</span>
          </>
        ) : (
          <>
            <Icon name="warning" /> <span>No key</span>
          </>
        )}
      </p>
      <div className="field">
        <label htmlFor={id}>
          API key<span className="visually-hidden"> for {provider.label}</span>
        </label>
        <input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        {error && (
          <p id={`${id}-error`} className="field-error">
            <Icon name="error" /> {error}
          </p>
        )}
      </div>
      <div className="actions">
        <button type="submit" className="button button-primary" disabled={pending}>
          Save key
        </button>
        {key.source === "settings" && !confirming && (
          <button type="button" className="button button-quiet" onClick={() => setConfirming(true)} disabled={pending}>
            Remove saved key
          </button>
        )}
      </div>
      {confirming && (
        <div role="group" aria-labelledby={`${id}-remove`} className="banner banner-warning">
          <Icon name="warning" />
          <div>
            <p id={`${id}-remove`} className="banner-title">
              Remove the saved {provider.label} key?
            </p>
            <p>Tests then use the server&apos;s key, if it has one; without any key, tests on {provider.label} models are refused.</p>
            <div className="actions">
              <button type="button" className="button button-danger" onClick={() => void send(null)} disabled={pending}>
                Yes, remove key
              </button>
              <button type="button" className="button button-secondary" onClick={() => setConfirming(false)}>
                Keep key
              </button>
            </div>
          </div>
        </div>
      )}
      {notice && (
        <p role="status" className="hint">
          {notice}
        </p>
      )}
    </form>
  );
}

function DefaultsForm({ view, onSaved }: { view: LlmSettingsView; onSaved: (view: LlmSettingsView) => void }) {
  // An environment model outside the catalog is not offered here: the user chooses one.
  const offered = view.models.some((m) => m.id === view.defaults.model);
  const [model, setModel] = useState(offered ? view.defaults.model : "");
  const [reasoning, setReasoning] = useState<ReasoningLevel>(offered ? view.defaults.reasoning : "default");
  const [errors, setErrors] = useState<{ model?: string; reasoning?: string }>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const selected = view.models.find((m) => m.id === model);

  const chooseModel = (id: string) => {
    setModel(id);
    // A level the new model does not take falls back to its default.
    if (!view.models.find((m) => m.id === id)?.reasoningLevels.includes(reasoning)) setReasoning("default");
    setErrors({});
    setNotice(null);
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (!model) {
      setErrors({ model: "Choose a model." });
      return;
    }
    setPending(true);
    setErrors({});
    setNotice(null);
    try {
      onSaved(await saveLlmDefaults({ model, reasoning }));
      setNotice("Defaults saved. New tests use them; tests already created keep their model.");
    } catch (err) {
      const field = err instanceof ApiRequestError && err.issues?.[0]?.path.at(-1) === "reasoning" ? "reasoning" : "model";
      setErrors({ [field]: messageOf(err, "The defaults couldn't be saved. Please try again.") });
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="card stack" aria-labelledby="defaults-title" onSubmit={onSubmit} noValidate>
      <div className="section-head">
        <h2 id="defaults-title" className="section-title">
          Defaults for new tests
        </h2>
        <p className="muted">The new-test form can pick another model or level for one test.</p>
      </div>
      {view.defaults.source === "environment" && (
        <p className="hint">
          <Icon name="info" /> These defaults come from the server&apos;s environment (<code>LLM_PROVIDER</code>, <code>LLM_MODEL</code>) until you
          save your own.
        </p>
      )}
      {!view.defaults.available && (
        <div role="alert" className="banner banner-warning">
          <Icon name="warning" />
          <div>
            <p className="banner-title">New tests will be refused</p>
            <p>The default model ({view.defaults.label}) has no API key. Add its provider&apos;s key above, or choose another model.</p>
          </div>
        </div>
      )}
      <div className="field-pair">
        <div className="field">
          <label htmlFor="defaults-model">Model</label>
          <select
            id="defaults-model"
            value={model}
            onChange={(e) => chooseModel(e.target.value)}
            aria-invalid={errors.model ? true : undefined}
            aria-describedby={errors.model ? "defaults-model-price defaults-model-error" : "defaults-model-price"}
          >
            {!model && (
              <option value="" disabled>
                Choose a model
              </option>
            )}
            <ModelOptions models={view.models} />
          </select>
          <p id="defaults-model-price" className="hint">
            {selected ? priceText(selected.price) : `The server's default model (${view.defaults.label}) is not offered here.`}
          </p>
          {errors.model && (
            <p id="defaults-model-error" className="field-error">
              <Icon name="error" /> {errors.model}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="defaults-reasoning">Reasoning</label>
          <select
            id="defaults-reasoning"
            value={reasoning}
            onChange={(e) => setReasoning(e.target.value as ReasoningLevel)}
            disabled={!selected}
            aria-invalid={errors.reasoning ? true : undefined}
            aria-describedby={errors.reasoning ? "defaults-reasoning-error" : undefined}
          >
            {(selected?.reasoningLevels ?? ["default"]).map((level) => (
              <option key={level} value={level}>
                {level === "default" ? modelDefaultLabel(selected) : LEVEL_LABEL[level]}
              </option>
            ))}
          </select>
          {errors.reasoning && (
            <p id="defaults-reasoning-error" className="field-error">
              <Icon name="error" /> {errors.reasoning}
            </p>
          )}
        </div>
      </div>
      <div className="actions">
        <button type="submit" className="button button-primary" disabled={pending}>
          Save defaults
        </button>
        {notice && (
          <p role="status" className="hint">
            {notice}
          </p>
        )}
      </div>
    </form>
  );
}
