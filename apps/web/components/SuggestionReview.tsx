"use client";

import type { Suggestion, SuggestionSetResponse, TestRunSummary } from "@platform/contracts";
import { useEffect, useState } from "react";
import { ApiRequestError, getSuggestions, selectSuggestion } from "../lib/api";
import { Disclosure } from "./Disclosure";
import { Icon } from "./Icon";
import { displayUrl } from "./report-format";

interface Props {
  runId: string;
  /** The server accepted the choice: the run now analyses that test (its new summary). */
  onSelected: (summary: TestRunSummary) => void;
  /** "None of these — cancel run": the page's own cancel confirmation takes over. */
  onCancel: () => void;
}

const MIN_TEXT = 10;
const MAX_TEXT = 20_000;
const TOO_SHORT = "Describe the test in at least 10 characters.";
const TOO_LONG = "Keep the test under 20,000 characters.";

const messageOf = (err: unknown) => (err instanceof ApiRequestError ? err.message : "Something went wrong. Please try again.");

interface Need {
  kind: "secret" | "testData";
  name: string;
  /** The run doesn't have it: only a separate test (with it entered) can provide it. */
  missing: boolean;
}

const needsOf = (s: Suggestion, run: SuggestionSetResponse["run"]): Need[] => [
  ...s.needs.secrets.map((name) => ({ kind: "secret" as const, name, missing: !run.secretNames.includes(name) })),
  ...s.needs.testData.map((name) => ({ kind: "testData" as const, name, missing: !run.testDataKeys.includes(name) })),
];

/**
 * "Choose what to test" (AWAITING_SELECTION, spec 2026-09-28-suggest-tests section 6): one card per
 * suggested test. "Test this" opens its text for editing, "Continue with this test" chooses it for
 * this run; any other can start as a separate test with the form pre-filled.
 */
export function SuggestionReview({ runId, onSelected, onCancel }: Props) {
  const [set, setSet] = useState<SuggestionSetResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The card whose text is open for editing, and the text as edited so far. */
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;
    getSuggestions(runId).then(
      (s) => live && setSet(s),
      (err: unknown) => live && setLoadError(messageOf(err)),
    );
    return () => {
      live = false;
    };
  }, [runId]);

  function open(s: Suggestion) {
    setDraft({ id: s.id, text: s.requirement });
    setFieldError(null);
    setError(null);
  }

  async function choose(s: Suggestion, text: string) {
    const trimmed = text.trim();
    if (trimmed.length < MIN_TEXT || trimmed.length > MAX_TEXT) {
      setFieldError(trimmed.length < MIN_TEXT ? TOO_SHORT : TOO_LONG);
      return;
    }
    setPending(true);
    setFieldError(null);
    setError(null);
    try {
      // The text goes along only when it was edited: the server then records the choice as edited.
      const body = trimmed === s.requirement ? { suggestionId: s.id } : { suggestionId: s.id, requirement: trimmed };
      onSelected(await selectSuggestion(runId, body));
    } catch (err) {
      setPending(false);
      const onText = err instanceof ApiRequestError ? (err.issues ?? []).filter((i) => i.path[0] === "requirement") : [];
      if (onText.length > 0) setFieldError(onText.map((i) => i.message).join(" "));
      else setError(messageOf(err));
    }
  }

  if (loadError) {
    return (
      <div role="alert" className="banner banner-error">
        <Icon name="warning" />
        <div>
          <p className="banner-title">The suggested tests couldn&apos;t be loaded</p>
          <p>{loadError}</p>
        </div>
      </div>
    );
  }
  if (!set) {
    return (
      <p className="muted" role="status">
        Loading suggested tests…
      </p>
    );
  }

  return (
    <section className="review" aria-labelledby="choose-title">
      <div className="review-main">
        <div className="review-head">
          <h2 id="choose-title" className="section-title">
            Choose what to test
          </h2>
          <p className="muted">
            The agent read the website and suggests these tests. Pick one to run now — you can edit its wording first — or start any
            other as a separate test.
          </p>
        </div>

        <div className="suggestion-list">
          {set.suggestions.map((s) => {
            const needs = needsOf(s, set.run);
            const editing = draft?.id === s.id ? draft : null;
            const textId = `${s.id}-text`;
            return (
              <article key={s.id} className="card suggestion" aria-labelledby={`${s.id}-title`}>
                <div className="suggestion-head">
                  <h3 id={`${s.id}-title`} className="suggestion-title">
                    {s.title}
                  </h3>
                  {s.destructive && (
                    <span className="badge badge-warning">
                      <Icon name="warning" /> Changes data
                    </span>
                  )}
                </div>
                {editing ? (
                  <div className="field">
                    <label htmlFor={textId}>The test to run</label>
                    <textarea
                      id={textId}
                      rows={4}
                      value={editing.text}
                      onChange={(e) => setDraft({ id: s.id, text: e.target.value })}
                      disabled={pending}
                      aria-invalid={fieldError ? true : undefined}
                      aria-describedby={fieldError ? `${textId}-error` : undefined}
                    />
                    {fieldError && (
                      <p id={`${textId}-error`} className="field-error">
                        <Icon name="error" /> {fieldError}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="suggestion-text">{s.requirement}</p>
                )}
                {s.why && <p className="muted">Why: {s.why}</p>}
                {needs.length > 0 && (
                  <div className="needs">
                    <span className="needs-label" aria-hidden="true">
                      Needs
                    </span>
                    <ul aria-label={`Needs for ${s.title}`}>
                      {needs.map((n) => (
                        <li key={`${n.kind}-${n.name}`} className={n.missing ? "need need-missing" : "need"}>
                          <Icon name={n.kind === "secret" ? "lock" : "data"} />
                          {n.name}
                          {n.missing && " — not provided: the run will make one up (start it as a separate test to give your own)"}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {s.destructive && !set.run.destructiveActionsAllowed && (
                  <p className="hint">
                    <Icon name="info" /> Will be blocked: this run doesn&apos;t allow destructive actions
                  </p>
                )}
                {editing && error && (
                  <div role="alert" className="banner banner-error">
                    <Icon name="warning" />
                    <div>
                      <p className="banner-title">That didn&apos;t work</p>
                      <p>{error}</p>
                    </div>
                  </div>
                )}
                <div className="actions">
                  {editing ? (
                    <>
                      <button type="button" className="button button-primary" onClick={() => void choose(s, editing.text)} disabled={pending}>
                        {pending ? "Starting…" : "Continue with this test"}
                        <Icon name="arrow" />
                      </button>
                      <button type="button" className="button button-secondary" onClick={() => setDraft(null)} disabled={pending}>
                        Back
                      </button>
                    </>
                  ) : (
                    <button type="button" className="button button-primary" onClick={() => open(s)} disabled={pending}>
                      Test this<span className="visually-hidden">: {s.title}</span>
                    </button>
                  )}
                  <a className="button button-secondary" href={`/runs/new?from=${encodeURIComponent(runId)}&suggestion=${encodeURIComponent(s.id)}`}>
                    Start as a separate test<span className="visually-hidden">: {s.title}</span>
                  </a>
                </div>
              </article>
            );
          })}
        </div>

        <div className="actions">
          <button type="button" className="button button-danger-quiet" onClick={onCancel} disabled={pending}>
            <Icon name="stop" />
            None of these — cancel run
          </button>
        </div>

        {set.pages.length > 0 && (
          <Disclosure title="Pages explored" hint={`The ${set.pages.length} pages the agent read to suggest these tests.`}>
            <ul className="pages-list">
              {set.pages.map((p) => (
                <li key={p.url}>
                  {displayUrl(p.url)} — {p.status === "READ" ? p.title || "Read" : "Skipped"}
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </div>
    </section>
  );
}
