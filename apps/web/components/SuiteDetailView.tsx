"use client";

import type { CredentialProfile, SuiteDetail, SuiteEntryView, SuiteRunBrief } from "@platform/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ApiRequestError,
  deleteSuite,
  getSuite,
  listCredentialProfiles,
  listSuiteRuns,
  removeSuiteEntry,
  reorderSuiteEntries,
  runSuite,
  updateSuite,
} from "../lib/api";
import { newIdempotencyKey } from "../lib/uuid";
import { Icon } from "./Icon";
import { LIFECYCLE_LABEL } from "./format";
import { displayUrl, formatWhen, plural } from "./report-format";
import { VerdictBadge } from "./StatusBadge";
import { SuiteSchedules } from "./SuiteSchedules";
import { SuiteRunOutcome, TRIGGER_LABEL, messageOf } from "./Suites";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; suite: SuiteDetail; runs: SuiteRunBrief[]; profiles: CredentialProfile[] };

interface Props {
  suiteId: string;
  navigate?: (url: string) => void;
}

/**
 * One suite (V1.2 F1): its tests in run order (move, remove), its saved credentials, "Run suite" (asking only for
 * the secrets nothing saved provides), its schedules (F3) and its recent runs.
 */
export function SuiteDetailView({ suiteId, navigate = (url) => window.location.assign(url) }: Props) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    Promise.all([getSuite(suiteId), listSuiteRuns(suiteId), listCredentialProfiles().catch(() => [] as CredentialProfile[])]).then(
      ([suite, runs, profiles]) => live && setState({ status: "ready", suite, runs, profiles }),
      (err: unknown) => live && setState({ status: "error", message: messageOf(err) }),
    );
    return () => {
      live = false;
    };
  }, [suiteId, attempt]);

  if (state.status === "loading") {
    return (
      <p className="muted" role="status">
        Loading the suite…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <div role="alert" className="banner banner-error">
        <Icon name="warning" />
        <div>
          <p className="banner-title">The suite couldn&apos;t be loaded</p>
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

  const { suite, runs, profiles } = state;
  const changed = (next: SuiteDetail) => setState((s) => (s.status === "ready" ? { ...s, suite: next } : s));

  return (
    <div className="stack-lg">
      <header className="stack-tight">
        <nav aria-label="Breadcrumb" className="breadcrumb">
          <ol>
            <li>
              <a href="/suites">Suites</a>
            </li>
            <li aria-current="page">{suite.name}</li>
          </ol>
        </nav>
        <h1 className="page-title">{suite.name}</h1>
        {suite.description && <p className="page-lede">{suite.description}</p>}
        <p className="muted">
          {plural(suite.entryCount, "test")}
          {suite.owner ? ` · ${suite.owner.name}` : ""}
          {suite.credentialProfile ? ` · saved credentials: ${suite.credentialProfile.name}` : ""}
        </p>
      </header>

      <RunSuiteCard suite={suite} profiles={profiles} navigate={navigate} />
      <EntriesCard suite={suite} onChange={changed} />
      <SuiteSchedules suite={suite} />
      <RecentRuns runs={runs} />
      <SuiteSettings suite={suite} profiles={profiles} onChange={changed} onDeleted={() => navigate("/suites")} />
    </div>
  );
}

function RunSuiteCard({ suite, profiles, navigate }: { suite: SuiteDetail; profiles: CredentialProfile[]; navigate: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [profileId, setProfileId] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const key = useRef<string | null>(null);
  const profile = profiles.find((p) => p.id === profileId);
  const covered = new Set(profile?.secretNames ?? []);
  const asked = suite.missingSecretNames;

  async function start(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    const next: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const name of asked) {
      const v = values[name] ?? "";
      if (v) {
        if (v.length < 4) next[name] = "Enter at least 4 characters.";
        else secrets[name] = v;
      } else if (!covered.has(name)) next[name] = `Enter ${name}, or choose saved credentials that have it.`;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setPending(true);
    setValues({});
    key.current ??= newIdempotencyKey();
    try {
      const started = await runSuite(suite.id, { secrets, ...(profileId ? { credentialProfileId: profileId } : {}) }, key.current);
      navigate(`/suite-runs/${encodeURIComponent(started.suiteRunId)}`);
    } catch (err) {
      key.current = null;
      if (err instanceof ApiRequestError && err.issues?.length) {
        setErrors(Object.fromEntries(err.issues.map((i) => [String(i.path.at(-1) ?? "form"), i.message])));
      } else {
        setErrors({ form: messageOf(err, "The suite couldn't be started.") });
      }
      setPending(false);
    }
  }

  const destructive = suite.entries.filter((e) => e.destructive).length;
  return (
    <section className="card stack" aria-labelledby="run-suite-title">
      <div className="section-head">
        <h2 id="run-suite-title" className="card-title">
          <Icon name="restart" /> Run the suite
        </h2>
        <p className="muted">
          Reruns every test&apos;s saved Playwright test as its own run — no exploring and no AI.
          {destructive > 0 && ` ${plural(destructive, "test")} repeat destructive actions.`}
        </p>
      </div>
      {!open ? (
        <div className="actions">
          <button type="button" className="button button-primary" onClick={() => setOpen(true)} disabled={suite.entryCount === 0}>
            <Icon name="restart" />
            Run suite
          </button>
          {suite.entryCount === 0 && <p className="muted">Add a test first.</p>}
        </div>
      ) : (
        <form className="stack" onSubmit={start} noValidate aria-busy={pending}>
          {asked.length > 0 && (
            <>
              <p className="hint">
                <Icon name="lock" /> The suite&apos;s saved credentials don&apos;t provide {asked.join(", ")}. Enter them for this run, or choose other
                saved credentials.
              </p>
              {profiles.length > 0 && (
                <div className="field">
                  <label htmlFor="suite-run-profile">Saved credentials for this run</label>
                  <select id="suite-run-profile" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                    <option value="">None</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.secretNames.join(", ")})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {asked.map((name) => (
                <div key={name} className="field">
                  <label htmlFor={`suite-secret-${name}`}>
                    <span className="mono">{name}</span>
                    {covered.has(name) && <span className="muted"> (from saved credentials unless you type one)</span>}
                  </label>
                  <input
                    id={`suite-secret-${name}`}
                    type="password"
                    autoComplete="new-password"
                    value={values[name] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setValues((vs) => ({ ...vs, [name]: v }));
                    }}
                    aria-invalid={errors[name] ? true : undefined}
                    aria-describedby={errors[name] ? `suite-secret-${name}-error` : undefined}
                  />
                  {errors[name] && (
                    <p id={`suite-secret-${name}-error`} className="field-error">
                      <Icon name="error" /> {errors[name]}
                    </p>
                  )}
                </div>
              ))}
            </>
          )}
          {asked.length === 0 && <p className="muted">Every secret the tests need comes from the suite&apos;s saved credentials.</p>}
          {(errors.form || errors.credentialProfileId || errors.targetUrl) && (
            <p role="alert" className="field-error">
              <Icon name="error" /> {errors.form ?? errors.credentialProfileId ?? errors.targetUrl}
            </p>
          )}
          <div className="actions">
            <button type="submit" className="button button-primary" disabled={pending}>
              {pending ? "Starting…" : `Run ${plural(suite.entryCount, "test")}`}
            </button>
            <button type="button" className="button button-secondary" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function EntryResult({ entry }: { entry: SuiteEntryView }) {
  const r = entry.lastResult;
  if (!r) return <span className="muted">Not run in this suite yet</span>;
  return (
    <a href={`/runs/${encodeURIComponent(r.runId)}`} className="entry-result">
      {r.verdict ? <VerdictBadge verdict={r.verdict} /> : <span className="status">{LIFECYCLE_LABEL[r.lifecycle]}</span>}
      <span className="visually-hidden"> (open the last run)</span>
    </a>
  );
}

function EntriesCard({ suite, onChange }: { suite: SuiteDetail; onChange: (s: SuiteDetail) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<SuiteDetail>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await fn());
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const move = (from: number, to: number) => {
    const ids = suite.entries.map((e) => e.sourceRunId);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id!);
    return act(() => reorderSuiteEntries(suite.id, ids));
  };
  const remove = (sourceRunId: string) =>
    act(async () => {
      await removeSuiteEntry(suite.id, sourceRunId);
      return getSuite(suite.id);
    });

  return (
    <section className="card stack" aria-labelledby="entries-title" aria-busy={busy}>
      <div className="section-head">
        <h2 id="entries-title" className="card-title">
          <Icon name="layers" /> Tests
        </h2>
        <p className="muted">They run in this order. Add a test from a finished run&apos;s report (&ldquo;Add to suite&rdquo;).</p>
      </div>
      {suite.entries.length === 0 ? (
        <p className="muted">No tests yet.</p>
      ) : (
        <ol className="suite-entries" aria-label="Tests in run order">
          {suite.entries.map((e, i) => (
            <li key={e.sourceRunId} className="suite-entry">
              <div className="suite-entry-main">
                <a href={`/runs/${encodeURIComponent(e.sourceRunId)}`} className="suite-entry-title">
                  {e.title || displayUrl(e.targetUrl)}
                </a>
                <p className="muted">
                  {displayUrl(e.targetUrl)} · {plural(e.compiledCriteria, "criterion", "criteria")} checked
                  {e.secretNames.length > 0 && ` · needs ${e.secretNames.join(", ")}`}
                </p>
                {e.destructive && (
                  <span className="meta-chip meta-chip-warning">
                    <Icon name="warning" /> Repeats destructive actions
                  </span>
                )}
              </div>
              <EntryResult entry={e} />
              <div className="actions suite-entry-actions">
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => void move(i, i - 1)}
                  disabled={busy || i === 0}
                  aria-label={`Move “${e.title}” up`}
                >
                  Up
                </button>
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => void move(i, i + 1)}
                  disabled={busy || i === suite.entries.length - 1}
                  aria-label={`Move “${e.title}” down`}
                >
                  Down
                </button>
                <button
                  type="button"
                  className="button button-quiet button-quiet-danger"
                  onClick={() => void remove(e.sourceRunId)}
                  disabled={busy}
                  aria-label={`Remove “${e.title}” from the suite`}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
      {error && (
        <p role="alert" className="field-error">
          <Icon name="error" /> {error}
        </p>
      )}
    </section>
  );
}

function RecentRuns({ runs }: { runs: SuiteRunBrief[] }) {
  return (
    <section className="card stack" aria-labelledby="suite-runs-title">
      <h2 id="suite-runs-title" className="card-title">
        Recent runs
      </h2>
      {runs.length === 0 ? (
        <p className="muted">This suite hasn&apos;t run yet.</p>
      ) : (
        <ul className="suite-run-list">
          {runs.map((r) => (
            <li key={r.id}>
              <a href={`/suite-runs/${encodeURIComponent(r.id)}`}>
                <time dateTime={r.createdAt}>{formatWhen(r.createdAt)}</time>
              </a>
              <SuiteRunOutcome run={r} />
              <span className="muted">{TRIGGER_LABEL[r.trigger]}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SuiteSettings({
  suite,
  profiles,
  onChange,
  onDeleted,
}: {
  suite: SuiteDetail;
  profiles: CredentialProfile[];
  onChange: (s: SuiteDetail) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(suite.name);
  const [description, setDescription] = useState(suite.description);
  const [profileId, setProfileId] = useState(suite.credentialProfile?.id ?? "");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setMessage({ kind: "error", text: "Enter a name." });
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      onChange(await updateSuite(suite.id, { name: name.trim(), description: description.trim(), credentialProfileId: profileId || null }));
      setMessage({ kind: "ok", text: "Saved." });
    } catch (err) {
      setMessage({ kind: "error", text: messageOf(err, "The suite couldn't be saved.") });
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    setPending(true);
    try {
      await deleteSuite(suite.id);
      onDeleted();
    } catch (err) {
      setMessage({ kind: "error", text: messageOf(err, "The suite couldn't be deleted.") });
      setPending(false);
    }
  }

  return (
    <form className="card stack" onSubmit={save} noValidate aria-labelledby="suite-settings-title" aria-busy={pending}>
      <h2 id="suite-settings-title" className="card-title">
        <Icon name="sliders" /> Suite settings
      </h2>
      <div className="field">
        <label htmlFor="suite-edit-name">Name</label>
        <input id="suite-edit-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="suite-edit-description">
          Description <span className="muted">(optional)</span>
        </label>
        <textarea id="suite-edit-description" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="suite-edit-profile">Saved credentials</label>
        <select id="suite-edit-profile" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
          <option value="">None</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.secretNames.join(", ")})
            </option>
          ))}
        </select>
        <p className="hint">Fill the tests&apos; secrets on every run. A scheduled run can only use these.</p>
      </div>
      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "field-error" : "muted"}>
          {message.kind === "error" && <Icon name="error" />} {message.text}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="button button-primary" disabled={pending}>
          Save settings
        </button>
        {confirmingDelete ? (
          <>
            <button type="button" className="button button-danger" onClick={() => void remove()} disabled={pending}>
              Delete “{suite.name}”
            </button>
            <button type="button" className="button button-secondary" onClick={() => setConfirmingDelete(false)} disabled={pending}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" className="button button-danger-quiet actions-end" onClick={() => setConfirmingDelete(true)} disabled={pending}>
            Delete suite
          </button>
        )}
      </div>
      {confirmingDelete && <p className="muted">Its schedules are deleted too; its past runs stay in the history.</p>}
    </form>
  );
}
