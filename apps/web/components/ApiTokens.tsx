"use client";

import { Field } from "@/components/ui/field";
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
    <div className="flex min-w-0 flex-col gap-7">
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
        <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-destructive [&_.icon]:mt-px">
          <Icon name="error" /> {error}
        </p>
      )}
      <Card as="section" className="flex min-w-0 flex-col gap-5" aria-labelledby="tokens-title">
        <h2 id="tokens-title" className="card-title mb-3.5 text-sm font-semibold text-muted-foreground">
          <Icon name="key" /> {all ? "Everyone's tokens" : "Your tokens"}
        </h2>
        {tokens === null && !error && (
          <p className="text-muted-foreground" role="status">
            Loading tokens…
          </p>
        )}
        {tokens?.length === 0 && <p className="text-muted-foreground">No tokens yet.</p>}
        {tokens && tokens.length > 0 && (
          <ul className="m-0 grid list-none gap-2.5 p-0 [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:gap-x-3.5 [&>li]:gap-y-2" aria-label="Tokens">
            {tokens.map((t) => (
              <li key={t.id} className="justify-between border-t border-(--border-soft) py-2.5 first:border-t-0">
                <div className="stack-tight flex min-w-0 flex-col gap-3">
                  <span>
                    <strong>{t.name}</strong> <span className="font-mono text-muted-foreground">tap_{t.prefix}…</span>
                    {all && <span className="text-muted-foreground"> · {t.user.name}</span>}
                  </span>
                  <span className="text-muted-foreground">
                    {t.scopes.map((s) => SCOPE_TEXT[s]).join(", ")} · {status(t)} ·{" "}
                    {t.lastUsedAt ? `last used ${formatWhen(t.lastUsedAt)}` : "never used"}
                  </span>
                </div>
                {live(t) && (
                  <Button variant="ghost" type="button" onClick={() => void revoke(t.id)} aria-label={`Revoke “${t.name}”`}>
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
    <Card as="form" className="flex min-w-0 flex-col gap-5" onSubmit={submit} noValidate aria-labelledby="new-token-title" aria-busy={pending}>
      <div className="flex flex-col gap-1.5 [&>.text-muted-foreground]:max-w-[68ch]">
        <h2 id="new-token-title" className="card-title mb-3.5 text-sm font-semibold text-muted-foreground">
          <Icon name="plus" /> New API token
        </h2>
        <p className="text-muted-foreground">For CI jobs and scripts: it acts as you, limited to what you allow here.</p>
      </div>
      <Field>
        <label htmlFor="token-name">Name</label>
        <Input id="token-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field as="fieldset">
        <legend>Permissions</legend>
        {(Object.keys(SCOPE_TEXT) as ApiTokenScope[]).map((s) => (
          <label key={s} className="flex min-h-8 cursor-pointer items-center gap-2.5 text-[0.9375rem] has-disabled:cursor-not-allowed has-disabled:text-muted-foreground">
            <Checkbox checked={scopes.includes(s)} onCheckedChange={() => toggle(s)} />
            {SCOPE_TEXT[s]}
          </label>
        ))}
      </Field>
      <Field>
        <label htmlFor="token-expiry">Expires after</label>
        <NativeSelect id="token-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value as typeof expiry)}>
          {EXPIRY.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-destructive [&_.icon]:mt-px">
          <Icon name="error" /> {error}
        </p>
      )}
      <div className="actions flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
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
        <code className="font-mono block rounded-sm bg-(--surface-sunken) px-2.5 py-2 wrap-anywhere select-all">{token.token}</code>
      </p>
      <div className="actions flex flex-wrap items-center gap-2">
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
        <Button variant="ghost" type="button" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
