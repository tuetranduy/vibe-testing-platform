"use client";

import { DataKeySchema, type TestDataSet, type TestDataValue } from "@platform/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { ApiRequestError, createTestDataSet, deleteTestDataSet, listTestDataSets, updateTestDataSet } from "../lib/api";
import { Icon } from "./Icon";
import { formatWhen, plural } from "./report-format";

type State = { status: "loading" } | { status: "ready"; sets: TestDataSet[] } | { status: "error"; message: string };

const messageOf = (err: unknown, fallback: string) =>
  err instanceof ApiRequestError ? (err.issues?.[0]?.message ?? err.message) : err instanceof Error ? err.message : fallback;

/** A value as the editor shows it (null as empty). */
const shown = (v: TestDataValue) => (v === null ? "" : String(v));

/**
 * Settings → Test data (V1.1 F3): named sets of test data a new test can start from, shared by everyone in
 * the workspace. A run copies the set when it is created, so editing a set never changes past runs.
 */
export function TestDataSets() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<TestDataSet | "new" | null>(null);

  useEffect(() => {
    let live = true;
    listTestDataSets().then(
      (sets) => live && setState({ status: "ready", sets }),
      (err: unknown) => live && setState({ status: "error", message: messageOf(err, "Something went wrong.") }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  if (state.status === "loading") {
    return (
      <p className="muted" role="status">
        Loading test data sets…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <div role="alert" className="banner banner-error">
        <Icon name="warning" />
        <div>
          <p className="banner-title">Test data sets couldn&apos;t be loaded</p>
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

  const saved = (set: TestDataSet) => {
    setState((s) =>
      s.status === "ready"
        ? { status: "ready", sets: [...s.sets.filter((x) => x.id !== set.id), set].sort((a, b) => a.name.localeCompare(b.name)) }
        : s,
    );
    setEditing(null);
  };
  const removed = (id: string) =>
    setState((s) => (s.status === "ready" ? { status: "ready", sets: s.sets.filter((x) => x.id !== id) } : s));

  return (
    <div className="stack-lg">
      {state.sets.length === 0 && editing === null && (
        <div className="card empty-state">
          <Icon name="data" />
          <h2>No test data sets yet</h2>
          <p className="muted">
            Save the values your tests type again and again — a test account&apos;s e-mail, a search term, an address.
          </p>
        </div>
      )}
      {state.sets.length > 0 && (
        <ul className="saved-list">
          {state.sets.map((set) =>
            editing !== "new" && editing?.id === set.id ? (
              <li key={set.id}>
                <SetEditor set={set} onSaved={saved} onCancel={() => setEditing(null)} />
              </li>
            ) : (
              <li key={set.id}>
                <SetCard set={set} onEdit={() => setEditing(set)} onDeleted={() => removed(set.id)} />
              </li>
            ),
          )}
        </ul>
      )}
      {editing === "new" ? (
        <SetEditor set={null} onSaved={saved} onCancel={() => setEditing(null)} />
      ) : (
        <div className="actions">
          <button type="button" className="button button-primary" onClick={() => setEditing("new")}>
            <Icon name="plus" />
            New test data set
          </button>
        </div>
      )}
    </div>
  );
}

function SetCard({ set, onEdit, onDeleted }: { set: TestDataSet; onEdit: () => void; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = Object.keys(set.values);
  return (
    <article className="card stack-tight" aria-labelledby={`set-${set.id}`}>
      <div className="saved-head">
        <h2 id={`set-${set.id}`} className="card-title">
          {set.name}
        </h2>
        <p className="muted">
          {plural(keys.length, "value")} · updated {formatWhen(set.updatedAt)}
          {set.createdBy ? ` · added by ${set.createdBy.name}` : ""}
        </p>
      </div>
      {keys.length > 0 && (
        <dl className="kv-list">
          {keys.map((k) => (
            <div key={k}>
              <dt className="mono">{k}</dt>
              <dd>{shown(set.values[k]!) || <span className="muted">(empty)</span>}</dd>
            </div>
          ))}
        </dl>
      )}
      {error && (
        <p role="alert" className="field-error">
          <Icon name="error" /> {error}
        </p>
      )}
      {confirming ? (
        <div role="group" aria-labelledby={`set-${set.id}-delete`} className="note note-warning">
          <p id={`set-${set.id}-delete`} className="note-title">
            Delete {set.name}?
          </p>
          <p>Runs already created keep their copy of the values.</p>
          <div className="actions">
            <button
              type="button"
              className="button button-danger"
              onClick={async () => {
                try {
                  await deleteTestDataSet(set.id);
                  onDeleted();
                } catch (err) {
                  setError(messageOf(err, "The set couldn't be deleted."));
                  setConfirming(false);
                }
              }}
            >
              Yes, delete
            </button>
            <button type="button" className="button button-secondary" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button type="button" className="button button-secondary" onClick={onEdit}>
            Edit <span className="visually-hidden">{set.name}</span>
          </button>
          <button type="button" className="button button-quiet" onClick={() => setConfirming(true)}>
            Delete <span className="visually-hidden">{set.name}</span>
          </button>
        </div>
      )}
    </article>
  );
}

interface Row {
  id: number;
  key: string;
  value: string;
  /** The saved value, so an untouched number or boolean keeps its type. */
  original?: TestDataValue;
}
let nextRowId = 1;

function SetEditor({ set, onSaved, onCancel }: { set: TestDataSet | null; onSaved: (set: TestDataSet) => void; onCancel: () => void }) {
  const [name, setName] = useState(set?.name ?? "");
  const [rows, setRows] = useState<Row[]>(() =>
    set && Object.keys(set.values).length > 0
      ? Object.entries(set.values).map(([key, v]) => ({ id: nextRowId++, key, value: shown(v), original: v }))
      : [{ id: nextRowId++, key: "", value: "" }],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const prefix = set ? `edit-${set.id}` : "new-set";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Enter a name.";
    const values: Record<string, TestDataValue> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (!key && !row.value) continue;
      if (!DataKeySchema.safeParse(key).success) next[`key-${row.id}`] = "Use letters, digits and _ (starting with a letter).";
      else if (key in values) next[`key-${row.id}`] = "This key is already used.";
      else values[key] = row.original !== undefined && shown(row.original) === row.value ? row.original : row.value;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setPending(true);
    try {
      const body = { name: name.trim(), values };
      onSaved(set ? await updateTestDataSet(set.id, body) : await createTestDataSet(body));
    } catch (err) {
      const issue = err instanceof ApiRequestError ? err.issues?.[0] : undefined;
      setErrors({ [issue?.path[0] === "name" ? "name" : "form"]: issue?.message ?? messageOf(err, "The set couldn't be saved.") });
      setPending(false);
    }
  }

  const error = (id: string) =>
    errors[id] && (
      <p id={`${prefix}-${id}-error`} className="field-error">
        <Icon name="error" /> {errors[id]}
      </p>
    );

  return (
    <form className="card stack" aria-labelledby={`${prefix}-title`} onSubmit={onSubmit} noValidate>
      <h2 id={`${prefix}-title`} className="card-title">
        {set ? `Edit ${set.name}` : "New test data set"}
      </h2>
      <div className="field">
        <label htmlFor={`${prefix}-name`}>Name</label>
        <input
          id={`${prefix}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Returning shopper"
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? `${prefix}-name-error` : undefined}
        />
        {error("name")}
      </div>
      <fieldset className="stack-tight">
        <legend className="field-legend">Values</legend>
        {rows.map((row, i) => (
          <div key={row.id} className="row">
            <div className="row-cell">
              <label className="visually-hidden" htmlFor={`${prefix}-key-${row.id}`}>
                Key {i + 1}
              </label>
              <input
                id={`${prefix}-key-${row.id}`}
                placeholder="Key, e.g. email"
                autoComplete="off"
                spellCheck={false}
                value={row.key}
                onChange={(e) => setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)))}
                aria-invalid={errors[`key-${row.id}`] ? true : undefined}
                aria-describedby={errors[`key-${row.id}`] ? `${prefix}-key-${row.id}-error` : undefined}
              />
              {error(`key-${row.id}`)}
            </div>
            <div className="row-cell">
              <label className="visually-hidden" htmlFor={`${prefix}-value-${row.id}`}>
                Value {i + 1}
              </label>
              <input
                id={`${prefix}-value-${row.id}`}
                placeholder="Value"
                autoComplete="off"
                value={row.value}
                onChange={(e) => setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))}
              />
            </div>
            <button type="button" className="button button-quiet" onClick={() => setRows((rs) => rs.filter((r) => r.id !== row.id))}>
              Remove <span className="visually-hidden">value {i + 1}</span>
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button button-secondary"
          onClick={() => setRows((rs) => [...rs, { id: nextRowId++, key: "", value: "" }])}
        >
          <Icon name="plus" />
          Add value
        </button>
        <p className="hint">
          <Icon name="info" /> Not for passwords: save those under Credentials, where they are encrypted and never shown again.
        </p>
      </fieldset>
      {errors.form && (
        <p role="alert" className="field-error">
          <Icon name="error" /> {errors.form}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="button button-primary" disabled={pending}>
          {set ? "Save changes" : "Save test data set"}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
