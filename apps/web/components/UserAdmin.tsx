"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { NativeSelect } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import type { UserRole, UserView } from "@platform/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { ApiRequestError, createUser, listUsers, updateUser } from "../lib/api";
import { useMe } from "../lib/me";
import { Icon } from "./Icon";
import { formatWhen } from "./report-format";

type State = { status: "loading" } | { status: "ready"; users: UserView[] } | { status: "error"; message: string };

const messageOf = (err: unknown, fallback: string) =>
  err instanceof ApiRequestError ? (err.issues?.[0]?.message ?? err.message) : err instanceof Error ? err.message : fallback;

const ROLE_LABEL: Record<UserRole, string> = { admin: "Administrator", member: "Member" };

/**
 * Settings → Users (administrators, V1.1 F1): add people, change their role, reset a password, disable
 * or re-enable an account. A tenant always keeps one enabled administrator (the API refuses otherwise).
 */
export function UserAdmin() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const me = useMe();

  useEffect(() => {
    let live = true;
    listUsers().then(
      (users) => live && setState({ status: "ready", users }),
      (err: unknown) => live && setState({ status: "error", message: messageOf(err, "Something went wrong.") }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  if (state.status === "loading") {
    return (
      <p className="muted" role="status">
        Loading users…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <div role="alert" className="banner banner-error">
        <Icon name="warning" />
        <div>
          <p className="banner-title">Users couldn&apos;t be loaded</p>
          <p>{state.message}</p>
          <div className="actions">
            <Button variant="outline" type="button"  onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const replace = (u: UserView) =>
    setState((s) =>
      s.status === "ready"
        ? { status: "ready", users: s.users.some((x) => x.id === u.id) ? s.users.map((x) => (x.id === u.id ? u : x)) : [...s.users, u] }
        : s,
    );

  return (
    <div className="stack-lg">
      <Card as="section" className="table-card" aria-labelledby="users-title">
        <div className="table-toolbar">
          <h2 id="users-title" className="card-title">
            People ({state.users.length})
          </h2>
        </div>
        <div className="data-table-wrap">
          <Table className="data-table">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">E-mail</TableHead>
                <TableHead scope="col">Role</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Added</TableHead>
                <TableHead scope="col">
                  <span className="visually-hidden">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.users.map((u) => (
                <UserRow key={u.id} user={u} isSelf={me?.id === u.id} onChanged={replace} />
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>
      <AddUserForm onCreated={replace} />
    </div>
  );
}

function UserRow({ user, isSelf, onChanged }: { user: UserView; isSelf: boolean; onChanged: (u: UserView) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState("");

  async function change(patch: Parameters<typeof updateUser>[1]) {
    setPending(true);
    setError(null);
    try {
      onChanged(await updateUser(user.id, patch));
      setResetting(false);
      setPassword("");
    } catch (err) {
      setError(messageOf(err, "The change couldn't be saved."));
    } finally {
      setPending(false);
    }
  }

  return (
    <TableRow className={user.disabled ? "row-disabled" : undefined}>
      <TableCell>
        {user.name}
        {isSelf && <span className="muted"> (you)</span>}
      </TableCell>
      <TableCell className="mono">{user.email}</TableCell>
      <TableCell>
        <label className="visually-hidden" htmlFor={`role-${user.id}`}>
          Role of {user.name}
        </label>
        <NativeSelect
          id={`role-${user.id}`}
          value={user.role}
          disabled={pending}
          onChange={(e) => void change({ role: e.target.value as UserRole })}
        >
          <option value="member">{ROLE_LABEL.member}</option>
          <option value="admin">{ROLE_LABEL.admin}</option>
        </NativeSelect>
      </TableCell>
      <TableCell>{user.disabled ? "Disabled" : "Active"}</TableCell>
      <TableCell>{formatWhen(user.createdAt)}</TableCell>
      <TableCell>
        <div className="actions actions-tight">
          <Button variant="ghost" type="button"  disabled={pending} onClick={() => setResetting((v) => !v)}>
            Reset password
          </Button>
          <Button variant="ghost"
            type="button"
            disabled={pending}
            onClick={() => void change({ disabled: !user.disabled })}
          >
            {user.disabled ? "Enable" : "Disable"}
          </Button>
        </div>
        {resetting && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (password.length < 10) setError("A password has at least 10 characters.");
              else void change({ password });
            }}
          >
            <label htmlFor={`pw-${user.id}`}>New password for {user.name}</label>
            <Input
              id={`pw-${user.id}`}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button variant="outline" type="submit"  disabled={pending}>
              Set password
            </Button>
          </form>
        )}
        {error && (
          <p role="alert" className="field-error">
            <Icon name="error" /> {error}
          </p>
        )}
      </TableCell>
    </TableRow>
  );
}

function AddUserForm({ onCreated }: { onCreated: (u: UserView) => void }) {
  const empty = { name: "", email: "", password: "", role: "member" as UserRole };
  const [values, setValues] = useState(empty);
  const [errors, setErrors] = useState<Partial<Record<keyof typeof empty, string>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    const next: typeof errors = {};
    if (!values.name.trim()) next.name = "Enter a name.";
    if (!/^[^\s@]+@[^\s@]+$/.test(values.email.trim())) next.email = "Enter an e-mail address.";
    if (values.password.length < 10) next.password = "A password has at least 10 characters.";
    setErrors(next);
    setNotice(null);
    if (Object.keys(next).length > 0) return;
    setPending(true);
    try {
      const user = await createUser({ ...values, email: values.email.trim(), name: values.name.trim() });
      onCreated(user);
      setValues(empty);
      setNotice(`${user.name} can now sign in with ${user.email}. Give them the password yourself.`);
    } catch (err) {
      const issue = err instanceof ApiRequestError ? err.issues?.[0] : undefined;
      const field = (issue?.path.at(-1) as keyof typeof empty | undefined) ?? "email";
      setErrors({ [field]: issue?.message ?? messageOf(err, "The user couldn't be added.") });
    } finally {
      setPending(false);
    }
  }

  const field = (f: "name" | "email" | "password", label: string, type: string, autoComplete: string) => (
    <div className="field">
      <label htmlFor={`new-user-${f}`}>{label}</label>
      <Input
        id={`new-user-${f}`}
        type={type}
        autoComplete={autoComplete}
        value={values[f]}
        onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
        aria-invalid={errors[f] ? true : undefined}
        aria-describedby={errors[f] ? `new-user-${f}-error` : undefined}
      />
      {errors[f] && (
        <p id={`new-user-${f}-error`} className="field-error">
          <Icon name="error" /> {errors[f]}
        </p>
      )}
    </div>
  );

  return (
    <Card as="form" className="stack" aria-labelledby="add-user-title" onSubmit={onSubmit} noValidate>
      <h2 id="add-user-title" className="card-title">
        Add a person
      </h2>
      <div className="field-pair">
        {field("name", "Name", "text", "off")}
        {field("email", "E-mail address", "email", "off")}
      </div>
      <div className="field-pair">
        {field("password", "First password", "password", "new-password")}
        <div className="field">
          <label htmlFor="new-user-role">Role</label>
          <NativeSelect id="new-user-role" value={values.role} onChange={(e) => setValues((v) => ({ ...v, role: e.target.value as UserRole }))}>
            <option value="member">{ROLE_LABEL.member} — their own test runs</option>
            <option value="admin">{ROLE_LABEL.admin} — everyone&apos;s runs, users and settings</option>
          </NativeSelect>
        </div>
      </div>
      <div className="actions">
        <Button type="submit"  disabled={pending}>
          Add person
        </Button>
        {notice && (
          <p role="status" className="hint">
            {notice}
          </p>
        )}
      </div>
    </Card>
  );
}
