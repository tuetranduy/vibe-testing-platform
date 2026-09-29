"use client";

import { SecretNameSchema, type CredentialProfile } from "@platform/contracts";
import { useEffect, useState, type FormEvent } from "react";
import {
  ApiRequestError,
  createCredentialProfile,
  deleteCredentialProfile,
  listCredentialProfiles,
  updateCredentialProfile,
} from "../lib/api";
import { isAdminUser, useMe } from "../lib/me";
import { Icon } from "./Icon";
import { formatWhen } from "./report-format";

type State = { status: "loading" } | { status: "ready"; profiles: CredentialProfile[] } | { status: "error"; message: string };

const messageOf = (err: unknown, fallback: string) =>
  err instanceof ApiRequestError ? (err.issues?.[0]?.message ?? err.message) : err instanceof Error ? err.message : fallback;

/**
 * Settings → Credentials (V1.1 F4): saved sets of secrets, such as a test account's username and password.
 * Values are encrypted and write-only: this page shows names, never a value. Administrators manage them;
 * everyone can pick one for a new test, which copies the values into that run (and deletes them when it ends).
 */
export function CredentialProfiles() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<CredentialProfile | "new" | null>(null);
  const admin = isAdminUser(useMe());

  useEffect(() => {
    let live = true;
    listCredentialProfiles().then(
      (profiles) => live && setState({ status: "ready", profiles }),
      (err: unknown) => live && setState({ status: "error", message: messageOf(err, "Something went wrong.") }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  if (state.status === "loading") {
    return (
      <p className="muted" role="status">
        Loading saved credentials…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <div role="alert" className="banner banner-error">
        <Icon name="warning" />
        <div>
          <p className="banner-title">Saved credentials couldn&apos;t be loaded</p>
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

  const saved = (p: CredentialProfile) => {
    setState((s) =>
      s.status === "ready"
        ? { status: "ready", profiles: [...s.profiles.filter((x) => x.id !== p.id), p].sort((a, b) => a.name.localeCompare(b.name)) }
        : s,
    );
    setEditing(null);
  };
  const removed = (id: string) =>
    setState((s) => (s.status === "ready" ? { status: "ready", profiles: s.profiles.filter((x) => x.id !== id) } : s));

  return (
    <div className="stack-lg">
      {!admin && (
        <p className="hint">
          <Icon name="info" /> Only administrators can add or change saved credentials. You can use them when you start a test.
        </p>
      )}
      {state.profiles.length === 0 && editing === null && (
        <div className="card empty-state">
          <Icon name="key" />
          <h2>No saved credentials yet</h2>
          <p className="muted">Save a test account&apos;s login once, then pick it when you start a test instead of typing it again.</p>
        </div>
      )}
      {state.profiles.length > 0 && (
        <ul className="saved-list">
          {state.profiles.map((p) => (
            <li key={p.id}>
              {editing !== "new" && editing?.id === p.id ? (
                <ProfileEditor profile={p} onSaved={saved} onCancel={() => setEditing(null)} />
              ) : (
                <ProfileCard profile={p} admin={admin} onEdit={() => setEditing(p)} onDeleted={() => removed(p.id)} />
              )}
            </li>
          ))}
        </ul>
      )}
      {admin &&
        (editing === "new" ? (
          <ProfileEditor profile={null} onSaved={saved} onCancel={() => setEditing(null)} />
        ) : (
          <div className="actions">
            <button type="button" className="button button-primary" onClick={() => setEditing("new")}>
              <Icon name="plus" />
              New saved credentials
            </button>
          </div>
        ))}
    </div>
  );
}

function ProfileCard({
  profile: p,
  admin,
  onEdit,
  onDeleted,
}: {
  profile: CredentialProfile;
  admin: boolean;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <article className="card stack-tight" aria-labelledby={`cp-${p.id}`}>
      <div className="saved-head">
        <h2 id={`cp-${p.id}`} className="card-title">
          <Icon name="key" /> {p.name}
        </h2>
        <p className="muted">
          updated {formatWhen(p.updatedAt)}
          {p.createdBy ? ` · added by ${p.createdBy.name}` : ""}
        </p>
      </div>
      {p.description && <p>{p.description}</p>}
      <ul className="needs" aria-label="Secrets it provides">
        {p.secretNames.map((n) => (
          <li key={n} className="need mono">
            <Icon name="lock" /> {n}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="field-error">
          <Icon name="error" /> {error}
        </p>
      )}
      {admin &&
        (confirming ? (
          <div role="group" aria-labelledby={`cp-${p.id}-delete`} className="note note-warning">
            <p id={`cp-${p.id}-delete`} className="note-title">
              Delete {p.name}?
            </p>
            <p>Its values are deleted. Runs already started keep their own copy until they end.</p>
            <div className="actions">
              <button
                type="button"
                className="button button-danger"
                onClick={async () => {
                  try {
                    await deleteCredentialProfile(p.id);
                    onDeleted();
                  } catch (err) {
                    setError(messageOf(err, "The saved credentials couldn't be deleted."));
                    setConfirming(false);
                  }
                }}
              >
                Yes, delete
              </button>
              <button type="button" className="button button-secondary" onClick={() => setConfirming(false)}>
                Keep them
              </button>
            </div>
          </div>
        ) : (
          <div className="actions">
            <button type="button" className="button button-secondary" onClick={onEdit}>
              Edit <span className="visually-hidden">{p.name}</span>
            </button>
            <button type="button" className="button button-quiet" onClick={() => setConfirming(true)}>
              Delete <span className="visually-hidden">{p.name}</span>
            </button>
          </div>
        ))}
    </article>
  );
}

interface Row {
  id: number;
  name: string;
  value: string;
  /** Saved before: an empty value keeps it. */
  existing: boolean;
}
let nextRowId = 1;

/**
 * Create or edit. Existing secrets are listed by name with an empty value: leave it empty to keep the saved
 * value, type to replace it, Remove to delete it. Values leave the page when the request is sent.
 */
function ProfileEditor({
  profile,
  onSaved,
  onCancel,
}: {
  profile: CredentialProfile | null;
  onSaved: (p: CredentialProfile) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(profile?.name ?? "");
  const [description, setDescription] = useState(profile?.description ?? "");
  const [rows, setRows] = useState<Row[]>(() =>
    profile
      ? profile.secretNames.map((n) => ({ id: nextRowId++, name: n, value: "", existing: true }))
      : [
          { id: nextRowId++, name: "username", value: "", existing: false },
          { id: nextRowId++, name: "password", value: "", existing: false },
        ],
  );
  const [removedNames, setRemovedNames] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const prefix = profile ? `cp-edit-${profile.id}` : "cp-new";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Enter a name.";
    const values: Record<string, string> = {};
    const seen = new Set<string>();
    for (const row of rows) {
      const n = row.name.trim();
      if (!n && !row.value) continue;
      if (!SecretNameSchema.safeParse(n).success) next[`name-${row.id}`] = "Start with a lowercase letter; use a–z, 0–9 or _ (up to 32).";
      else if (seen.has(n)) next[`name-${row.id}`] = "This name is already used.";
      seen.add(n);
      if (row.existing && !row.value) continue; // keep the saved value
      if (row.value.length < 4) next[`value-${row.id}`] = row.value ? "Enter at least 4 characters." : "Enter the value.";
      else if (!next[`name-${row.id}`]) values[n] = row.value;
    }
    if (seen.size === 0) next.form = "Add at least one secret.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setPending(true);
    // Values leave component state as soon as the request is built, whatever the answer.
    setRows((rs) => rs.map((r) => ({ ...r, value: "" })));
    try {
      const saved = profile
        ? await updateCredentialProfile(profile.id, {
            name: name.trim(),
            description: description.trim(),
            secrets: { ...Object.fromEntries(removedNames.filter((n) => !seen.has(n)).map((n) => [n, null])), ...values },
          })
        : await createCredentialProfile({ name: name.trim(), description: description.trim(), secrets: values });
      onSaved(saved);
    } catch (err) {
      const issue = err instanceof ApiRequestError ? err.issues?.[0] : undefined;
      setErrors({
        [issue?.path[0] === "name" ? "name" : "form"]:
          `${issue?.message ?? messageOf(err, "The credentials couldn't be saved.")} Enter the values again.`,
      });
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
        {profile ? `Edit ${profile.name}` : "New saved credentials"}
      </h2>
      <div className="field-pair">
        <div className="field">
          <label htmlFor={`${prefix}-name`}>Name</label>
          <input
            id={`${prefix}-name`}
            value={name}
            placeholder="e.g. Staging admin"
            onChange={(e) => setName(e.target.value)}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? `${prefix}-name-error` : undefined}
          />
          {error("name")}
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-description`}>Description (optional)</label>
          <input id={`${prefix}-description`} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>
      <fieldset className="stack-tight">
        <legend className="field-legend">Secrets</legend>
        {profile && (
          <p className="hint">
            <Icon name="lock" /> Saved values are never shown. Leave a value empty to keep it, or type a new one to replace it.
          </p>
        )}
        {rows.map((row, i) => (
          <div key={row.id} className="row">
            <div className="row-cell">
              <label className="visually-hidden" htmlFor={`${prefix}-name-${row.id}`}>
                Secret {i + 1} name
              </label>
              <input
                id={`${prefix}-name-${row.id}`}
                placeholder="Name, e.g. password"
                autoComplete="off"
                spellCheck={false}
                value={row.name}
                readOnly={row.existing}
                onChange={(e) => setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, name: e.target.value } : r)))}
                aria-invalid={errors[`name-${row.id}`] ? true : undefined}
                aria-describedby={errors[`name-${row.id}`] ? `${prefix}-name-${row.id}-error` : undefined}
              />
              {error(`name-${row.id}`)}
            </div>
            <div className="row-cell">
              <label className="visually-hidden" htmlFor={`${prefix}-value-${row.id}`}>
                Secret {i + 1} value
              </label>
              <input
                id={`${prefix}-value-${row.id}`}
                type="password"
                autoComplete="new-password"
                placeholder={row.existing ? "Saved — type to replace" : "Value"}
                value={row.value}
                onChange={(e) => {
                  const value = e.target.value;
                  setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, value } : r)));
                }}
                aria-invalid={errors[`value-${row.id}`] ? true : undefined}
                aria-describedby={errors[`value-${row.id}`] ? `${prefix}-value-${row.id}-error` : undefined}
              />
              {error(`value-${row.id}`)}
            </div>
            <button
              type="button"
              className="button button-quiet"
              onClick={() => {
                if (row.existing) setRemovedNames((ns) => [...ns, row.name]);
                setRows((rs) => rs.filter((r) => r.id !== row.id));
              }}
            >
              Remove <span className="visually-hidden">secret {i + 1}</span>
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button button-secondary"
          onClick={() => setRows((rs) => [...rs, { id: nextRowId++, name: "", value: "", existing: false }])}
        >
          <Icon name="plus" />
          Add secret
        </button>
      </fieldset>
      {errors.form && (
        <p role="alert" className="field-error">
          <Icon name="error" /> {errors.form}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="button button-primary" disabled={pending}>
          {profile ? "Save changes" : "Save credentials"}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
