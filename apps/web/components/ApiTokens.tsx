"use client";

import type { ApiTokenScope, ApiTokenView, CreatedApiToken } from "@platform/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { createApiToken, listApiTokens, revokeApiToken } from "../lib/api";
import { Icon } from "./Icon";
import { formatWhen } from "./report-format";
import { messageOf } from "./Suites";

const SCOPE_TEXT: Record<ApiTokenScope, string> = {
  "suites:run": "Run suites",
  "results:read": "Read results",
};

const EXPIRY = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never" },
] as const;

function status(t: ApiTokenView): string {
  if (t.revokedAt) return `Revoked ${formatWhen(t.revokedAt)}`;
  if (t.expiresAt && new Date(t.expiresAt).getTime() <= Date.now()) return `Expired ${formatWhen(t.expiresAt)}`;
  return t.expiresAt ? `Expires ${formatWhen(t.expiresAt)}` : "Never expires";
}

const live = (t: ApiTokenView) => !t.revokedAt && (!t.expiresAt || new Date(t.expiresAt).getTime() > Date.now());

/**
 * API tokens (V1.2 F4). `all`: an administrator's view of everyone's tokens (revoke only). Otherwise the signed-in
 * person's own: create one (shown once, with a copy button), see when each was last used, revoke.
 */
export function ApiTokens({ all = false }: { all?: boolean }) {
  const [tokens, setTokens] = useState<ApiTokenView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);

  useEffect(() => {
    let alive = true;
    listApiTokens(all).then(
      (items) => alive && setTokens(items),
      (err: unknown) => alive && setError(messageOf(err)),
    );
    return () => {
      alive = false;
    };
  }, [all]);

  async function revoke(id: string) {
    setError(null);
    try {
      const revoked = await revokeApiToken(id);
      setTokens((ts) => (ts ?? []).map((t) => (t.id === id ? revoked : t)));
    } catch (err) {
      setError(messageOf(err, "The token couldn't be revoked."));
    }
  }

  return (
    <div className="stack-lg">
      {!all && (
        <NewToken
          onCreated={(t) => {
            setCreated(t);
            setTokens((ts) => [t, ...(ts ?? [])]);
          }}
        />
      )}
      {created && <CreatedToken token={created} onDone={() => setCreated(null)} />}
      {error && (
        <p role="alert" className="field-error">
          <Icon name="error" /> {error}
        </p>
      )}
      <section className="card stack" aria-labelledby="tokens-title">
        <h2 id="tokens-title" className="card-title">
          <Icon name="key" /> {all ? "Everyone's tokens" : "Your tokens"}
        </h2>
        {tokens === null && !error && (
          <p className="muted" role="status">
            Loading tokens…
          </p>
        )}
        {tokens?.length === 0 && <p className="muted">No tokens yet.</p>}
        {tokens && tokens.length > 0 && (
          <ul className="suite-run-list" aria-label="Tokens">
            {tokens.map((t) => (
              <li key={t.id} className="schedule-row">
                <div className="stack-tight">
                  <span>
                    <strong>{t.name}</strong> <span className="mono muted">tap_{t.prefix}…</span>
                    {all && <span className="muted"> · {t.user.name}</span>}
                  </span>
                  <span className="muted">
                    {t.scopes.map((s) => SCOPE_TEXT[s]).join(", ")} · {status(t)} ·{" "}
                    {t.lastUsedAt ? `last used ${formatWhen(t.lastUsedAt)}` : "never used"}
                  </span>
                </div>
                {live(t) && (
                  <button type="button" className="button button-quiet" onClick={() => void revoke(t.id)} aria-label={`Revoke “${t.name}”`}>
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function NewToken({ onCreated }: { onCreated: (t: CreatedApiToken) => void }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiTokenScope[]>(["suites:run", "results:read"]);
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]["value"]>("90");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Enter a name, e.g. the pipeline that uses it.");
    if (scopes.length === 0) return setError("Choose at least one permission.");
    setPending(true);
    setError(null);
    try {
      onCreated(
        await createApiToken({ name: name.trim(), scopes, expiresInDays: expiry === "never" ? null : (Number(expiry) as 30 | 90 | 365) }),
      );
      setName("");
    } catch (err) {
      setError(messageOf(err, "The token couldn't be created."));
    } finally {
      setPending(false);
    }
  }

  const toggle = (s: ApiTokenScope) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  return (
    <form className="card stack" onSubmit={submit} noValidate aria-labelledby="new-token-title" aria-busy={pending}>
      <div className="section-head">
        <h2 id="new-token-title" className="card-title">
          <Icon name="plus" /> New API token
        </h2>
        <p className="muted">For CI jobs and scripts: it acts as you, limited to what you allow here.</p>
      </div>
      <div className="field">
        <label htmlFor="token-name">Name</label>
        <input id="token-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </div>
      <fieldset className="field">
        <legend>Permissions</legend>
        {(Object.keys(SCOPE_TEXT) as ApiTokenScope[]).map((s) => (
          <label key={s} className="choice">
            <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />
            {SCOPE_TEXT[s]}
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor="token-expiry">Expires after</label>
        <select id="token-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value as typeof expiry)}>
          {EXPIRY.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p role="alert" className="field-error">
          <Icon name="error" /> {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="button button-primary" disabled={pending}>
          {pending ? "Creating…" : "Create token"}
        </button>
      </div>
    </form>
  );
}

function CreatedToken({ token, onDone }: { token: CreatedApiToken; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="note note-warning" role="status">
      <p className="note-title">Copy “{token.name}” now: it won&apos;t be shown again</p>
      <p>
        <code className="mono token-value">{token.token}</code>
      </p>
      <div className="actions">
        <button
          type="button"
          className="button button-secondary"
          onClick={() =>
            void navigator.clipboard?.writeText(token.token).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          <Icon name="copy" /> {copied ? "Copied" : "Copy token"}
        </button>
        <button type="button" className="button button-quiet" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
