"use client";

import { useState, type FormEvent } from "react";
import { ApiRequestError, login } from "../lib/api";
import { resetMe } from "../lib/me";
import { Icon } from "./Icon";

/** Only same-app paths: an absolute or protocol-relative `next` would send the user elsewhere after sign-in. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || next.startsWith("/login")) return "/";
  return next;
}

const messageOf = (err: unknown): string => {
  if (err instanceof ApiRequestError) {
    if (err.code === "INVALID_CREDENTIALS") return "The e-mail address or password is not correct.";
    if (err.code === "TOO_MANY_ATTEMPTS") return "Too many failed sign-ins. Try again in 15 minutes.";
    return err.message;
  }
  return "Couldn't sign in. Please try again.";
};

/**
 * The sign-in form (V1.1 F1). The session lands in an httpOnly cookie; this page never sees it. `tenant`: the
 * organization named by `/login?org=…` (KI-035); absent, the platform's default one.
 */
export function LoginForm({
  next,
  tenant,
  navigate = (url) => window.location.assign(url),
}: {
  next?: string | null;
  tenant?: string | null;
  navigate?: (url: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (!email.trim() || !password) {
      setError("Enter your e-mail address and password.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await login(email.trim(), password, tenant);
      resetMe();
      navigate(safeNext(next));
    } catch (err) {
      setPassword("");
      setError(messageOf(err));
      setPending(false);
    }
  }

  return (
    <form className="card stack login-card" aria-labelledby="login-title" onSubmit={onSubmit} noValidate>
      <div className="section-head">
        <h1 id="login-title" className="page-title">
          Sign in
        </h1>
        <p className="muted">
          Use the account your administrator created for you
          {tenant ? (
            <>
              {" "}
              in <strong className="mono">{tenant}</strong>
            </>
          ) : null}
          .
        </p>
      </div>
      {error && (
        <div role="alert" className="banner banner-error">
          <Icon name="warning" />
          <div>
            <p>{error}</p>
          </div>
        </div>
      )}
      <div className="field">
        <label htmlFor="login-email">E-mail address</label>
        <input id="login-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="actions">
        <button type="submit" className="button button-primary" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </form>
  );
}
