"use client";

import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
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
      <Card as="section" className="stack" aria-labelledby="tokens-title">
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
                  <Button variant="ghost" type="button"  onClick={() => void revoke(t.id)} aria-label={`Revoke “${t.name}”`}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
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
    <Card as="form" className="stack" onSubmit={submit} noValidate aria-labelledby="new-token-title" aria-busy={pending}>
      <div className="section-head">
        <h2 id="new-token-title" className="card-title">
          <Icon name="plus" /> New API token
        </h2>
        <p className="muted">For CI jobs and scripts: it acts as you, limited to what you allow here.</p>
      </div>
      <div className="field">
        <label htmlFor="token-name">Name</label>
        <Input id="token-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </div>
      <fieldset className="field">
        <legend>Permissions</legend>
        {(Object.keys(SCOPE_TEXT) as ApiTokenScope[]).map((s) => (
          <label key={s} className="choice">
            <Checkbox checked={scopes.includes(s)} onCheckedChange={() => toggle(s)} />
            {SCOPE_TEXT[s]}
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor="token-expiry">Expires after</label>
        <NativeSelect id="token-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value as typeof expiry)}>
          {EXPIRY.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      {error && (
        <p role="alert" className="field-error">
          <Icon name="error" /> {error}
        </p>
      )}
      <div className="actions">
        <Button type="submit"  disabled={pending}>
          {pending ? "Creating…" : "Create token"}
        </Button>
      </div>
    </Card>
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
        <Button variant="outline"
          type="button"
          onClick={() =>
            void navigator.clipboard?.writeText(token.token).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          <Icon name="copy" /> {copied ? "Copied" : "Copy token"}
        </Button>
        <Button variant="ghost" type="button"  onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
