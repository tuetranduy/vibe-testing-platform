"use client";

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useState, type FormEvent } from "react";
import { ApiRequestError, changePassword, logout } from "../lib/api";
import { resetMe, useMe } from "../lib/me";
import { Icon } from "./Icon";

type Field = "currentPassword" | "newPassword" | "confirm";

/** Your account: who you are signed in as, and a new password (your other sessions end; this one stays). */
export function AccountSettings({ navigate = (url: string) => window.location.assign(url) }: { navigate?: (url: string) => void }) {
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
    <Field>
      <label htmlFor={`account-${f}`}>{label}</label>
      <Input
        id={`account-${f}`}
        type="password"
        autoComplete={autoComplete}
        value={values[f]}
        onChange={set(f)}
        aria-invalid={errors[f] ? true : undefined}
        aria-describedby={errors[f] ? `account-${f}-error` : undefined}
      />
      {errors[f] && (
        <p id={`account-${f}-error`} className="flex items-start gap-1.5 text-sm font-medium text-destructive [&_.icon]:mt-px">
          <Icon name="error" /> {errors[f]}
        </p>
      )}
    </Field>
  );

  return (
    <div className="flex min-w-0 flex-col gap-7">
      {me && (
        <Card as="section" className="stack-tight flex min-w-0 flex-col gap-3" aria-labelledby="account-who">
          <h2 id="account-who" className="card-title mb-3.5 text-sm font-semibold text-muted-foreground">
            Signed in as
          </h2>
          <p>
            <strong>{me.name}</strong> · {me.email} · {me.role === "admin" ? "Administrator" : "Member"}
          </p>
          <div className="actions flex flex-wrap items-center gap-2">
            <Button variant="outline"
              type="button"
              onClick={async () => {
                await logout().catch(() => {});
                resetMe();
                navigate("/login");
              }}
            >
              Sign out
            </Button>
          </div>
        </Card>
      )}
      <Card as="form" className="flex min-w-0 flex-col gap-5" aria-labelledby="account-password" onSubmit={onSubmit} noValidate>
        <h2 id="account-password" className="card-title mb-3.5 text-sm font-semibold text-muted-foreground">
          Change password
        </h2>
        {input("currentPassword", "Current password", "current-password")}
        {input("newPassword", "New password", "new-password")}
        {input("confirm", "New password again", "new-password")}
        <div className="actions flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={pending}>
            Change password
          </Button>
          {notice && (
            <p role="status" className="hint text-[0.8125rem] text-(--text-subtle) [&_.icon]:mr-0.5">
              {notice}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
