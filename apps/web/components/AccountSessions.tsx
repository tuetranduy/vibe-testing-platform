"use client";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { SessionInfo } from "@platform/contracts";
import { useEffect, useState } from "react";
import { listSessions, revokeOtherSessions, revokeSession } from "../lib/api";
import { Icon } from "./Icon";
import { formatWhen } from "./report-format";
import { messageOf } from "./Suites";

/** "Firefox on macOS" from a User-Agent; the raw string when nothing is recognised. */
export function describeAgent(ua: string | null): string {
  if (!ua) return "Unknown browser";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X|Macintosh/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? ua.slice(0, 80);
}

/** Your sessions (KI-034): where you are signed in, with "Sign out" for one and for every other. */
export function AccountSessions() {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listSessions().then(
      (items) => alive && setSessions(items),
      (err: unknown) => alive && setError(messageOf(err, "Your sessions couldn't be loaded.")),
    );
    return () => {
      alive = false;
    };
  }, []);

  async function endOne(id: string) {
    setError(null);
    setNotice(null);
    try {
      await revokeSession(id);
      setSessions((ss) => (ss ?? []).filter((s) => s.id !== id));
    } catch (err) {
      setError(messageOf(err, "The session couldn't be signed out."));
    }
  }

  async function endOthers() {
    setError(null);
    setNotice(null);
    try {
      const n = await revokeOtherSessions();
      setSessions((ss) => (ss ?? []).filter((s) => s.current));
      setNotice(n === 1 ? "Signed out 1 other session." : `Signed out ${n} other sessions.`);
    } catch (err) {
      setError(messageOf(err, "The other sessions couldn't be signed out."));
    }
  }

  const others = (sessions ?? []).filter((s) => !s.current).length;
  return (
    <Card as="section" className="flex min-w-0 flex-col gap-5" aria-labelledby="account-sessions">
      <h2 id="account-sessions" className="card-title mb-3.5 text-sm font-semibold text-muted-foreground">
        <Icon name="monitor" /> Where you're signed in
      </h2>
      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-destructive [&_.icon]:mt-px">
          <Icon name="error" /> {error}
        </p>
      )}
      {sessions === null && !error && (
        <p className="text-muted-foreground" role="status">
          Loading sessions…
        </p>
      )}
      {sessions && sessions.length > 0 && (
        <ul className="m-0 grid list-none gap-2.5 p-0 [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:gap-x-3.5 [&>li]:gap-y-2" aria-label="Sessions">
          {sessions.map((s) => (
            <li key={s.id} className="justify-between border-t border-(--border-soft) py-2.5 first:border-t-0">
              <div className="stack-tight flex min-w-0 flex-col gap-3">
                <span>
                  <strong>{describeAgent(s.userAgent)}</strong>
                  {s.current && <span className="text-muted-foreground"> · this session</span>}
                </span>
                <span className="text-muted-foreground">
                  Signed in {formatWhen(s.createdAt)} · last active {formatWhen(s.lastSeenAt)} · ends {formatWhen(s.expiresAt)}
                </span>
              </div>
              {!s.current && (
                <Button variant="ghost" type="button" onClick={() => void endOne(s.id)} aria-label={`Sign out ${describeAgent(s.userAgent)}, signed in ${formatWhen(s.createdAt)}`}>
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="actions flex flex-wrap items-center gap-2">
        <Button variant="outline" type="button" onClick={() => void endOthers()} disabled={sessions !== null && others === 0}>
          Sign out other sessions
        </Button>
        {notice && (
          <p role="status" className="hint text-[0.8125rem] text-(--text-subtle) [&_.icon]:mr-0.5">
            {notice}
          </p>
        )}
      </div>
    </Card>
  );
}
