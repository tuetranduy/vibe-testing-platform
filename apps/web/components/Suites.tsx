"use client";

import type { SuiteRunBrief, SuiteView } from "@platform/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { ApiRequestError, createSuite, listSuites } from "../lib/api";
import { Icon } from "./Icon";
import { formatWhen, plural } from "./report-format";
import { VerdictBadge } from "./StatusBadge";

type State = { status: "loading" } | { status: "ready"; suites: SuiteView[] } | { status: "error"; message: string };

export const messageOf = (err: unknown, fallback = "Something went wrong.") =>
  err instanceof ApiRequestError ? (err.issues?.[0]?.message ?? err.message) : err instanceof Error ? err.message : fallback;

/** A suite run's outcome: its verdict once settled, "Running" before. */
export function SuiteRunOutcome({ run }: { run: Pick<SuiteRunBrief, "status" | "verdict"> }) {
  if (run.status === "COMPLETED" && run.verdict) return <VerdictBadge verdict={run.verdict} />;
  return (
    <span className="status">
      <Icon name="current" /> Running
    </span>
  );
}

export const TRIGGER_LABEL: Record<SuiteRunBrief["trigger"], string> = {
  manual: "Started by hand",
  schedule: "Scheduled",
  api: "Started through the API",
};

/**
 * The suites page (V1.2 F1): each suite with its size and last result, and a form for a new one. Tests are
 * added from a finished run's report ("Add to suite").
 */
export function Suites({ navigate = (url: string) => window.location.assign(url) }: { navigate?: (url: string) => void }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let live = true;
    listSuites().then(
      (suites) => live && setState({ status: "ready", suites }),
      (err: unknown) => live && setState({ status: "error", message: messageOf(err) }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  if (state.status === "loading") {
    return (
      <p className="muted" role="status">
        Loading suites…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <div role="alert" className="banner banner-error">
        <Icon name="warning" />
        <div>
          <p className="banner-title">Suites couldn&apos;t be loaded</p>
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

  return (
    <div className="stack-lg">
      {state.suites.length === 0 && !creating && (
        <div className="card empty-state">
          <Icon name="layers" />
          <h2>No suites yet</h2>
          <p className="muted">
            A suite reruns saved Playwright tests together — no exploring and no AI. Create one, then add tests from finished runs.
          </p>
        </div>
      )}
      {state.suites.length > 0 && (
        <ul className="saved-list">
          {state.suites.map((s) => (
            <li key={s.id}>
              <article className="card stack-tight" aria-labelledby={`suite-${s.id}`}>
                <div className="saved-head">
                  <h2 id={`suite-${s.id}`} className="card-title">
                    <a href={`/suites/${encodeURIComponent(s.id)}`}>{s.name}</a>
                  </h2>
                  {s.lastRun && <SuiteRunOutcome run={s.lastRun} />}
                </div>
                {s.description && <p>{s.description}</p>}
                <p className="muted">
                  {plural(s.entryCount, "test")}
                  {s.lastRun ? (
                    <>
                      {" · last run "}
                      <time dateTime={s.lastRun.createdAt}>{formatWhen(s.lastRun.createdAt)}</time>
                    </>
                  ) : (
                    " · never run"
                  )}
                  {s.owner ? ` · ${s.owner.name}` : ""}
                </p>
              </article>
            </li>
          ))}
        </ul>
      )}
      {creating ? (
        <NewSuiteForm onCancel={() => setCreating(false)} onCreated={(id) => navigate(`/suites/${encodeURIComponent(id)}`)} />
      ) : (
        <div className="actions">
          <button type="button" className="button button-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            New suite
          </button>
        </div>
      )}
    </div>
  );
}

function NewSuiteForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Enter a name.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const suite = await createSuite({ name: name.trim(), description: description.trim() });
      onCreated(suite.id);
    } catch (err) {
      setError(messageOf(err, "The suite couldn't be created."));
      setPending(false);
    }
  }

  return (
    <form className="card stack" onSubmit={submit} noValidate aria-labelledby="new-suite-title" aria-busy={pending}>
      <h2 id="new-suite-title" className="card-title">
        New suite
      </h2>
      <div className="field">
        <label htmlFor="suite-name">Name</label>
        <input
          id="suite-name"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "suite-name-error" : undefined}
        />
        {error && (
          <p id="suite-name-error" className="field-error">
            <Icon name="error" /> {error}
          </p>
        )}
      </div>
      <div className="field">
        <label htmlFor="suite-description">
          Description <span className="muted">(optional)</span>
        </label>
        <textarea id="suite-description" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="actions">
        <button type="submit" className="button button-primary" disabled={pending}>
          {pending ? "Creating…" : "Create suite"}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
