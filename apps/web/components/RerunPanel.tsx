"use client";

import type { CredentialProfile } from "@platform/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiRequestError, listCredentialProfiles, rerunRun } from "../lib/api";
import { newIdempotencyKey } from "../lib/uuid";
import { Icon } from "./Icon";

interface Props {
  runId: string;
  /** The secrets the saved test fills: their values were deleted when the run ended, so they are asked again. */
  secretNames: readonly string[];
  /** How many criteria the saved test checks. */
  compiledCount: number;
  navigate?: (url: string) => void;
}

/**
 * "Rerun test" (V1.1 F5): starts a new run that reruns this run's saved Playwright test, with no exploration
 * and no AI. Asks for the secrets the test needs (typed, or saved credentials); opens the new run.
 */
export function RerunPanel({ runId, secretNames, compiledCount, navigate = (url) => window.location.assign(url) }: Props) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [profiles, setProfiles] = useState<CredentialProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const key = useRef<string | null>(null);

  useEffect(() => {
    if (!open || secretNames.length === 0) return;
    let live = true;
    listCredentialProfiles().then(
      (ps) => live && setProfiles(ps),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [open, secretNames.length]);

  const profile = profiles.find((p) => p.id === profileId);
  const covered = new Set(profile?.secretNames ?? []);

  async function start(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    const next: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const name of secretNames) {
      const v = values[name] ?? "";
      if (v) {
        if (v.length < 4) next[name] = "Enter at least 4 characters.";
        else secrets[name] = v;
      } else if (!covered.has(name)) next[name] = `Enter ${name}, or choose saved credentials that have it.`;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setPending(true);
    // Secret values leave the page as soon as the request is built.
    setValues({});
    key.current ??= newIdempotencyKey();
    try {
      const created = await rerunRun(runId, { secrets, ...(profileId ? { credentialProfileId: profileId } : {}) }, key.current);
      navigate(`/runs/${encodeURIComponent(created.runId)}`);
    } catch (err) {
      key.current = null;
      if (err instanceof ApiRequestError && err.issues?.length) {
        setErrors(Object.fromEntries(err.issues.map((i) => [String(i.path.at(-1) ?? "form"), i.message])));
      } else {
        setErrors({ form: err instanceof Error ? err.message : "The rerun couldn't be started." });
      }
      setPending(false);
    }
  }

  return (
    <section className="card stack rerun-panel" aria-labelledby="rerun-title">
      <div className="section-head">
        <h2 id="rerun-title" className="card-title">
          <Icon name="restart" /> Rerun the saved test
        </h2>
        <p className="muted">
          Runs this test&apos;s generated Playwright test again as a new run — no exploring and no AI. It checks{" "}
          {compiledCount === 1 ? "1 criterion" : `${compiledCount} criteria`}; the others are reported as not rerun.
        </p>
      </div>
      {!open ? (
        <div className="actions">
          <button type="button" className="button button-secondary" onClick={() => setOpen(true)}>
            <Icon name="restart" />
            Rerun test
          </button>
        </div>
      ) : (
        <form className="stack" onSubmit={start} noValidate aria-busy={pending}>
          {secretNames.length > 0 && (
            <>
              <p className="hint">
                <Icon name="lock" /> Secret values were deleted when this run ended. Enter them again, or use saved credentials.
              </p>
              {profiles.length > 0 && (
                <div className="field">
                  <label htmlFor="rerun-profile">Saved credentials</label>
                  <select id="rerun-profile" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                    <option value="">None</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.secretNames.join(", ")})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {secretNames.map((name) => (
                <div key={name} className="field">
                  <label htmlFor={`rerun-secret-${name}`}>
                    <span className="mono">{name}</span>
                    {covered.has(name) && <span className="muted"> (from saved credentials unless you type one)</span>}
                  </label>
                  <input
                    id={`rerun-secret-${name}`}
                    type="password"
                    autoComplete="new-password"
                    value={values[name] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setValues((vs) => ({ ...vs, [name]: v }));
                    }}
                    aria-invalid={errors[name] ? true : undefined}
                    aria-describedby={errors[name] ? `rerun-secret-${name}-error` : undefined}
                  />
                  {errors[name] && (
                    <p id={`rerun-secret-${name}-error`} className="field-error">
                      <Icon name="error" /> {errors[name]}
                    </p>
                  )}
                </div>
              ))}
            </>
          )}
          {(errors.form || errors.credentialProfileId) && (
            <p role="alert" className="field-error">
              <Icon name="error" /> {errors.form ?? errors.credentialProfileId}
            </p>
          )}
          <div className="actions">
            <button type="submit" className="button button-primary" disabled={pending}>
              {pending ? "Starting…" : "Start rerun"}
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
