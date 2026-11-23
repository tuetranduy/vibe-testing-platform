"use client";

import { Field } from "@/components/ui/field";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
      <p className="text-muted-foreground" role="status">
        Loading suggested tests…
      </p>
    );
  }

  return (
    <section className="review" aria-labelledby="choose-title">
      <div className="review-main">
        <div className="review-head">
          <h2 id="choose-title" className="font-heading text-2xl leading-[1.2] font-semibold tracking-[-0.015em]">
            Choose what to test
          </h2>
          <p className="text-muted-foreground">
            The agent read the website and suggests these tests. Pick one to run now — you can edit its wording first — or start any
            other as a separate test.
          </p>
        </div>

        <div className="suggestion-list">
          {set.suggestions.map((s) => {
            const editing = draft?.id === s.id ? draft : null;
            const textId = `${s.id}-text`;
            return (
              <Card as="article" key={s.id} className="suggestion" aria-labelledby={`${s.id}-title`}>
                <div className="suggestion-head">
                  <h3 id={`${s.id}-title`} className="suggestion-title">
                    {s.title}
                  </h3>
                  {s.destructive && (
                    <Badge variant="outline" className="min-h-6 gap-1.5 border-transparent bg-(--warning-bg) text-(--warning)">
                      <Icon name="warning" /> Changes data
                    </Badge>
                  )}
                </div>
                {editing ? (
                  <Field>
                    <label htmlFor={textId}>The test to run</label>
                    <Textarea
                      id={textId}
                      rows={4}
                      value={editing.text}
                      onChange={(e) => setDraft({ id: s.id, text: e.target.value })}
                      disabled={pending}
                      aria-invalid={fieldError ? true : undefined}
                      aria-describedby={fieldError ? `${textId}-error` : undefined}
                    />
                    {fieldError && (
                      <p id={`${textId}-error`} className="flex items-start gap-1.5 text-sm font-medium text-destructive [&_.icon]:mt-px">
                        <Icon name="error" /> {fieldError}
                      </p>
                    )}
                  </Field>
                ) : (
                  <p className="suggestion-text">{s.requirement}</p>
                )}
                {s.why && <p className="text-muted-foreground">Why: {s.why}</p>}
                {s.destructive && !set.run.destructiveActionsAllowed && (
                  <p className="hint text-[0.8125rem] text-(--text-subtle) [&_.icon]:mr-0.5">
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
                <div className="actions flex flex-wrap items-center gap-2">
                  {editing ? (
                    <>
                      <Button type="button" onClick={() => void choose(s, editing.text)} disabled={pending}>
                        {pending ? "Starting…" : "Continue with this test"}
                        <Icon name="arrow" />
                      </Button>
                      <Button variant="outline" type="button" onClick={() => setDraft(null)} disabled={pending}>
                        Back
                      </Button>
                    </>
                  ) : (
                    <Button type="button" onClick={() => open(s)} disabled={pending}>
                      Test this<span className="sr-only">: {s.title}</span>
                    </Button>
                  )}
                  <Button asChild variant="outline">
                    <a href={`/runs/new?from=${encodeURIComponent(runId)}&suggestion=${encodeURIComponent(s.id)}`}>
                      Start as a separate test<span className="sr-only">: {s.title}</span>
                    </a>
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>

        <div className="actions flex flex-wrap items-center gap-2">
          <Button variant="destructive" type="button" onClick={onCancel} disabled={pending}>
            <Icon name="stop" />
            None of these — cancel run
          </Button>
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
