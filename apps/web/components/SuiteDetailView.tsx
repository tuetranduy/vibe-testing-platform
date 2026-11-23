"use client";

import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { SuiteDetail, SuiteEntryView, SuiteRunBrief } from "@platform/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  deleteSuite,
  getSuite,
  listSuiteRuns,
  removeSuiteEntry,
  reorderSuiteEntries,
  runSuite,
  updateSuite,
} from "../lib/api";
import { newIdempotencyKey } from "../lib/uuid";
import { Icon } from "./Icon";
import { displayUrl, formatWhen, plural } from "./report-format";
import { LifecycleBadge, VerdictBadge } from "./StatusBadge";
import { SuiteSchedules } from "./SuiteSchedules";
import { SuiteRunOutcome, TRIGGER_LABEL, messageOf } from "./Suites";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; suite: SuiteDetail; runs: SuiteRunBrief[] };

interface Props {
  suiteId: string;
  navigate?: (url: string) => void;
}

/** A suite’s tests, direct replay, schedules and run history. */
export function SuiteDetailView({ suiteId, navigate = (url) => window.location.assign(url) }: Props) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    Promise.all([getSuite(suiteId), listSuiteRuns(suiteId)]).then(
      ([suite, runs]) => live && setState({ status: "ready", suite, runs }),
      (err: unknown) => live && setState({ status: "error", message: messageOf(err) }),
    );
    return () => {
      live = false;
    };
  }, [suiteId, attempt]);

  if (state.status === "loading") {
    return (
      <p className="text-muted-foreground" role="status">
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
          <div className="actions flex flex-wrap items-center gap-2">
            <Button variant="outline" type="button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const { suite, runs } = state;
  const changed = (next: SuiteDetail) => setState((s) => (s.status === "ready" ? { ...s, suite: next } : s));

  return (
    <div className="flex min-w-0 flex-col gap-7">
      <header className="stack-tight flex min-w-0 flex-col gap-3">
        <nav aria-label="Breadcrumb" className="breadcrumb">
          <ol>
            <li>
              <a href="/suites">Suites</a>
            </li>
            <li aria-current="page">{suite.name}</li>
          </ol>
        </nav>
        <h1 className="page-title">{suite.name}</h1>
        {suite.description && <p className="max-w-[650px] text-[0.95rem] leading-[1.7] text-muted-foreground">{suite.description}</p>}
        <p className="text-muted-foreground">
          {plural(suite.entryCount, "test")}
          {suite.owner ? ` · ${suite.owner.name}` : ""}
        </p>
      </header>

      <RunSuiteCard suite={suite} navigate={navigate} />
      <EntriesCard suite={suite} onChange={changed} />
      <SuiteSchedules suite={suite} />
      <RecentRuns runs={runs} />
      <SuiteSettings suite={suite} onChange={changed} onDeleted={() => navigate("/suites")} />
    </div>
  );
}

function RunSuiteCard({ suite, navigate }: { suite: SuiteDetail; navigate: (url: string) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const legacy = suite.secretNames.length > 0;
  async function start() {
    if (pending) return;
    setPending(true);
    setError(null);
    key.current ??= newIdempotencyKey();
    try {
      const created = await runSuite(suite.id, {}, key.current);
      navigate(`/suite-runs/${encodeURIComponent(created.suiteRunId)}`);
    } catch (err) {
      setError(messageOf(err, "The suite couldn’t be started."));
      setPending(false);
    }
  }
  return <Card as="section" className="flex min-w-0 flex-col gap-5" aria-labelledby="run-suite-title">
    <div className="flex flex-col gap-1.5 [&>.text-muted-foreground]:max-w-[68ch]"><h2 id="run-suite-title" className="card-title mb-3.5 text-sm font-semibold text-muted-foreground">Run this suite</h2><p className="text-muted-foreground">Replay all {plural(suite.entryCount, "saved test")} in order.</p></div>
    {legacy && <p className="note note-warning">Some saved tests use an older setup. Replace them with fresh tests before running this suite.</p>}
    {error && <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-destructive [&_.icon]:mt-px">{error}</p>}
    <div className="actions flex flex-wrap items-center gap-2"><Button type="button" onClick={() => void start()} disabled={pending || legacy || suite.entryCount === 0}><Icon name="arrow" />{pending ? "Starting…" : "Run suite"}</Button>{suite.entryCount === 0 && <p className="text-muted-foreground">Add a test first.</p>}</div>
  </Card>;
}

function EntryResult({ entry }: { entry: SuiteEntryView }) {
  const r = entry.lastResult;
  if (!r) return <span className="text-muted-foreground">Not run in this suite yet</span>;
  return (
    <a href={`/runs/${encodeURIComponent(r.runId)}`} className="no-underline">
      {r.verdict ? <VerdictBadge verdict={r.verdict} /> : <LifecycleBadge lifecycle={r.lifecycle} />}
      <span className="sr-only"> (open the last run)</span>
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
    <Card as="section" className="flex min-w-0 flex-col gap-5" aria-labelledby="entries-title" aria-busy={busy}>
      <div className="flex flex-col gap-1.5 [&>.text-muted-foreground]:max-w-[68ch]">
        <h2 id="entries-title" className="card-title mb-3.5 text-sm font-semibold text-muted-foreground">
          <Icon name="layers" /> Tests
        </h2>
        <p className="text-muted-foreground">They run in this order. Add a test from a finished run&apos;s report (&ldquo;Add to suite&rdquo;).</p>
      </div>
      {suite.entries.length === 0 ? (
        <p className="text-muted-foreground">No tests yet.</p>
      ) : (
        <ol className="m-0 grid list-none p-0" aria-label="Tests in run order">
          {suite.entries.map((e, i) => (
            <li key={e.sourceRunId} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-2 border-t border-(--border-soft) py-3.5 first:border-t-0 max-[720px]:grid-cols-1">
              <div className="grid min-w-0 gap-1">
                <a href={`/runs/${encodeURIComponent(e.sourceRunId)}`} className="font-[560] wrap-anywhere text-foreground no-underline hover:text-accent-foreground hover:underline">
                  {e.title || displayUrl(e.targetUrl)}
                </a>
                <p className="text-muted-foreground">
                  {displayUrl(e.targetUrl)} · {plural(e.compiledCriteria, "criterion", "criteria")} checked
                </p>
                {e.destructive && (
                  <span className="meta-chip meta-chip-warning">
                    <Icon name="warning" /> Repeats destructive actions
                  </span>
                )}
              </div>
              <EntryResult entry={e} />
              <div className="actions flex flex-wrap items-center gap-2 gap-1">
                <Button variant="ghost"
                  type="button"
                  onClick={() => void move(i, i - 1)}
                  disabled={busy || i === 0}
                  aria-label={`Move “${e.title}” up`}
                >
                  Up
                </Button>
                <Button variant="ghost"
                  type="button"
                  onClick={() => void move(i, i + 1)}
                  disabled={busy || i === suite.entries.length - 1}
                  aria-label={`Move “${e.title}” down`}
                >
                  Down
                </Button>
                <Button variant="ghost"
                  type="button"
                  className="button-quiet-danger"
                  onClick={() => void remove(e.sourceRunId)}
                  disabled={busy}
                  aria-label={`Remove “${e.title}” from the suite`}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-destructive [&_.icon]:mt-px">
          <Icon name="error" /> {error}
        </p>
      )}
    </Card>
  );
}

function RecentRuns({ runs }: { runs: SuiteRunBrief[] }) {
  return (
    <Card as="section" className="flex min-w-0 flex-col gap-5" aria-labelledby="suite-runs-title">
      <h2 id="suite-runs-title" className="card-title mb-3.5 text-sm font-semibold text-muted-foreground">
        Recent runs
      </h2>
      {runs.length === 0 ? (
        <p className="text-muted-foreground">This suite hasn&apos;t run yet.</p>
      ) : (
        <ul className="m-0 grid list-none gap-2.5 p-0 [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:gap-x-3.5 [&>li]:gap-y-2">
          {runs.map((r) => (
            <li key={r.id}>
              <a href={`/suite-runs/${encodeURIComponent(r.id)}`}>
                <time dateTime={r.createdAt}>{formatWhen(r.createdAt)}</time>
              </a>
              <SuiteRunOutcome run={r} />
              <span className="text-muted-foreground">{TRIGGER_LABEL[r.trigger]}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SuiteSettings({
  suite,
  onChange,
  onDeleted,
}: {
  suite: SuiteDetail;
  onChange: (s: SuiteDetail) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(suite.name);
  const [description, setDescription] = useState(suite.description);
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
      onChange(await updateSuite(suite.id, { name: name.trim(), description: description.trim(), credentialProfileId: null }));
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
    <Card as="form" className="flex min-w-0 flex-col gap-5" onSubmit={save} noValidate aria-labelledby="suite-settings-title" aria-busy={pending}>
      <h2 id="suite-settings-title" className="card-title mb-3.5 text-sm font-semibold text-muted-foreground">
        <Icon name="sliders" /> Suite settings
      </h2>
      <Field>
        <label htmlFor="suite-edit-name">Name</label>
        <Input id="suite-edit-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field>
        <label htmlFor="suite-edit-description">
          Description <span className="text-muted-foreground">(optional)</span>
        </label>
        <Textarea id="suite-edit-description" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "flex items-start gap-1.5 text-sm font-medium text-destructive [&_.icon]:mt-px" : "text-muted-foreground"}>
          {message.kind === "error" && <Icon name="error" />} {message.text}
        </p>
      )}
      <div className="actions flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          Save settings
        </Button>
        {confirmingDelete ? (
          <>
            <Button variant="destructive" type="button" onClick={() => void remove()} disabled={pending}>
              Delete “{suite.name}”
            </Button>
            <Button variant="outline" type="button" onClick={() => setConfirmingDelete(false)} disabled={pending}>
              Keep it
            </Button>
          </>
        ) : (
          <Button variant="danger-outline" type="button" className="ml-auto" onClick={() => setConfirmingDelete(true)} disabled={pending}>
            Delete suite
          </Button>
        )}
      </div>
      {confirmingDelete && <p className="text-muted-foreground">Its schedules are deleted too; its past runs stay in the history.</p>}
    </Card>
  );
}
