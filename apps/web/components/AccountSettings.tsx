"use client";

import { useState, type FormEvent } from "react";
import { ApiRequestError, changePassword } from "../lib/api";
import { useMe } from "../lib/me";
import { Icon } from "./Icon";

type Field = "currentPassword" | "newPassword" | "confirm";

/** Your account: who you are signed in as, and a new password (your other sessions end; this one stays). */
export function AccountSettings() {
  const me = useMe();
  const [values, setValues] = useState<Record<Field, string>>({ currentPassword: "", newPassword: "", confirm: "" });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const set = (f: Field) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [f]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    const next: Partial<Record<Field, string>> = {};
    if (!values.currentPassword) next.currentPassword = "Enter your current password.";
    if (values.newPassword.length < 10) next.newPassword = "A password has at least 10 characters.";
    else if (values.newPassword !== values.confirm) next.confirm = "The two new passwords are not the same.";
    setErrors(next);
    setNotice(null);
    if (Object.keys(next).length > 0) return;
    setPending(true);
    try {
      await changePassword(values.currentPassword, values.newPassword);
      setValues({ currentPassword: "", newPassword: "", confirm: "" });
      setNotice("Password changed. You stay signed in here; other devices are signed out.");
    } catch (err) {
      const issue = err instanceof ApiRequestError ? err.issues?.[0] : undefined;
      const field = (issue?.path.at(-1) as Field | undefined) ?? "currentPassword";
      setErrors({ [field]: issue?.message ?? (err instanceof Error ? err.message : "Couldn't change the password.") });
    } finally {
      setPending(false);
    }
  }

  const input = (f: Field, label: string, autoComplete: string) => (
    <div className="field">
      <label htmlFor={`account-${f}`}>{label}</label>
      <input
        id={`account-${f}`}
        type="password"
        autoComplete={autoComplete}
        value={values[f]}
        onChange={set(f)}
        aria-invalid={errors[f] ? true : undefined}
        aria-describedby={errors[f] ? `account-${f}-error` : undefined}
      />
      {errors[f] && (
        <p id={`account-${f}-error`} className="field-error">
          <Icon name="error" /> {errors[f]}
        </p>
      )}
    </div>
  );

  return (
    <div className="stack-lg">
      {me && (
        <section className="card stack-tight" aria-labelledby="account-who">
          <h2 id="account-who" className="card-title">
            Signed in as
          </h2>
          <p>
            <strong>{me.name}</strong> · {me.email} · {me.role === "admin" ? "Administrator" : "Member"}
          </p>
        </section>
      )}
      <form className="card stack" aria-labelledby="account-password" onSubmit={onSubmit} noValidate>
        <h2 id="account-password" className="card-title">
          Change password
        </h2>
        {input("currentPassword", "Current password", "current-password")}
        {input("newPassword", "New password", "new-password")}
        {input("confirm", "New password again", "new-password")}
        <div className="actions">
          <button type="submit" className="button button-primary" disabled={pending}>
            Change password
          </button>
          {notice && (
            <p role="status" className="hint">
              {notice}
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
