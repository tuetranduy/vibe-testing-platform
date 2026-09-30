"use client";

import type { SuiteView } from "@platform/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { ApiRequestError, addSuiteEntry, createSuite, listSuites } from "../lib/api";
import { Icon } from "./Icon";
import { messageOf } from "./Suites";

interface Props {
  runId: string;
  /** The run allowed destructive actions: every run of the suite repeats them, so adding it must be confirmed. */
  destructive?: boolean;
}

const NEW = "__new__";

/**
 * "Add to suite" (V1.2 F1): puts this run's saved Playwright test into a suite (an existing one or a new one), so
 * it reruns with the others — no AI. A rerun adds the run that generated its test.
 */
export function AddToSuitePanel({ runId, destructive = false }: Props) {
  const [open, setOpen] = useState(false);
  const [suites, setSuites] = useState<SuiteView[] | null>(null);
  const [choice, setChoice] = useState("");
  const [newName, setNewName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [added, setAdded] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (!open || suites) return;
    let live = true;
    listSuites().then(
      (items) => {
        if (!live) return;
        setSuites(items);
        setChoice(items[0]?.id ?? NEW);
      },
      (err: unknown) => live && setError(messageOf(err, "Suites couldn't be loaded.")),
    );
    return () => {
      live = false;
    };
  }, [open, suites]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (choice === NEW && !newName.trim()) return setError("Enter a name for the new suite.");
    if (destructive && !confirmed) return setError("Confirm that every run of the suite repeats destructive actions.");
    setPending(true);
    setError(null);
    try {
      const suiteId = choice === NEW ? (await createSuite({ name: newName.trim() })).id : choice;
      const suite = await addSuiteEntry(suiteId, { sourceRunId: runId, ...(destructive ? { confirmDestructiveActions: true } : {}) });
      setAdded({ id: suite.id, name: suite.name });
    } catch (err) {
      setError(err instanceof ApiRequestError && err.code === "ENTRY_EXISTS" ? "This test is already in that suite." : messageOf(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card stack" aria-labelledby="add-to-suite-title">
      <div className="section-head">
        <h2 id="add-to-suite-title" className="card-title">
          <Icon name="layers" /> Add to a suite
        </h2>
        <p className="muted">Rerun this test with others, by hand, on a schedule or from CI — always without AI.</p>
      </div>
      {added ? (
        <p role="status">
          <Icon name="check" /> Added to <a href={`/suites/${encodeURIComponent(added.id)}`}>{added.name}</a>.
        </p>
      ) : !open ? (
        <div className="actions">
          <button type="button" className="button button-secondary" onClick={() => setOpen(true)}>
            <Icon name="plus" />
            Add to suite
          </button>
        </div>
      ) : (
        <form className="stack" onSubmit={submit} noValidate aria-busy={pending}>
          {suites === null && !error && (
            <p className="muted" role="status">
              Loading suites…
            </p>
          )}
          {suites !== null && (
            <div className="field">
              <label htmlFor="add-suite-choice">Suite</label>
              <select id="add-suite-choice" value={choice} onChange={(e) => setChoice(e.target.value)}>
                {suites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                <option value={NEW}>New suite…</option>
              </select>
            </div>
          )}
          {choice === NEW && (
            <div className="field">
              <label htmlFor="add-suite-name">New suite&apos;s name</label>
              <input id="add-suite-name" value={newName} maxLength={100} onChange={(e) => setNewName(e.target.value)} />
            </div>
          )}
          {destructive && (
            <div className="note note-warning">
              <p className="note-title">This run allowed destructive actions</p>
              <p>Every run of the suite repeats every action the test recorded: whatever it deleted, ordered or paid for happens again.</p>
              <label className="choice">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                I understand: repeat the destructive actions on every run
              </label>
            </div>
          )}
          {error && (
            <p role="alert" className="field-error">
              <Icon name="error" /> {error}
            </p>
          )}
          <div className="actions">
            <button type="submit" className="button button-primary" disabled={pending || suites === null}>
              {pending ? "Adding…" : "Add"}
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
