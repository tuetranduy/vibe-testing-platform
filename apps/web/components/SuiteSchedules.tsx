"use client";

import type { ScheduleView, SuiteDetail } from "@platform/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { ApiRequestError, createSchedule, deleteSchedule, listSchedules, updateSchedule } from "../lib/api";
import { Icon } from "./Icon";
import { formatWhen } from "./report-format";
import { messageOf } from "./Suites";

type Preset = "daily" | "weekdays" | "hourly" | "custom";

const PRESET_LABEL: Record<Preset, string> = {
  daily: "Every day at…",
  weekdays: "Monday to Friday at…",
  hourly: "Every hour",
  custom: "Custom (cron)",
};

/** The five-field cron of a preset; `time` is "HH:MM". */
export function presetCron(preset: Exclude<Preset, "custom">, time: string): string {
  const [h, m] = time.split(":").map((x) => Number.parseInt(x, 10));
  const hour = Number.isFinite(h) ? h : 9;
  const minute = Number.isFinite(m) ? m : 0;
  if (preset === "hourly") return `${minute} * * * *`;
  return `${minute} ${hour} * * ${preset === "weekdays" ? "1-5" : "*"}`;
}

/** A schedule's cron in words when it is one of the presets'; the expression itself otherwise. */
export function describeCron(cron: string): string {
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$/.exec(cron);
  if (daily) {
    const at = `${daily[2]!.padStart(2, "0")}:${daily[1]!.padStart(2, "0")}`;
    return daily[3] === "*" ? `Every day at ${at}` : `Monday to Friday at ${at}`;
  }
  const hourly = /^(\d{1,2}) \* \* \* \*$/.exec(cron);
  if (hourly) return `Every hour at :${hourly[1]!.padStart(2, "0")}`;
  return cron;
}

const OUTCOME_TEXT: Record<NonNullable<ScheduleView["lastOutcome"]>, string> = {
  started: "started a run",
  skipped_running: "skipped: the previous run was still going",
  failed: "failed",
};

const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/**
 * A suite's schedules (V1.2 F3): when it runs by itself, as whoever created the schedule, with the suite's saved
 * credentials only (so a schedule can't be added while they miss a secret).
 */
export function SuiteSchedules({ suite }: { suite: SuiteDetail }) {
  const [schedules, setSchedules] = useState<ScheduleView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let live = true;
    listSchedules(suite.id).then(
      (items) => live && setSchedules(items),
      (err: unknown) => live && setLoadError(messageOf(err)),
    );
    return () => {
      live = false;
    };
  }, [suite.id]);

  const replace = (s: ScheduleView) => setSchedules((all) => (all ?? []).map((x) => (x.id === s.id ? s : x)));
  const blocked = suite.missingSecretNames.length > 0;

  return (
    <section className="card stack" aria-labelledby="schedules-title">
      <div className="section-head">
        <h2 id="schedules-title" className="card-title">
          <Icon name="pending" /> Schedules
        </h2>
        <p className="muted">The suite runs by itself at these times, as the person who added the schedule.</p>
      </div>
      {blocked && (
        <p className="hint">
          <Icon name="lock" /> A scheduled run can only use the suite&apos;s saved credentials, which don&apos;t provide{" "}
          {suite.missingSecretNames.join(", ")}. Choose saved credentials that do in the suite settings.
        </p>
      )}
      {loadError && (
        <p role="alert" className="field-error">
          <Icon name="error" /> Schedules couldn&apos;t be loaded: {loadError}
        </p>
      )}
      {schedules && schedules.length === 0 && !adding && <p className="muted">No schedules.</p>}
      {schedules && schedules.length > 0 && (
        <ul className="suite-run-list" aria-label="Schedules">
          {schedules.map((s) => (
            <ScheduleRow key={s.id} schedule={s} blocked={blocked} onChange={replace} onDeleted={() => setSchedules((all) => (all ?? []).filter((x) => x.id !== s.id))} />
          ))}
        </ul>
      )}
      {adding ? (
        <NewSchedule
          suiteId={suite.id}
          onCancel={() => setAdding(false)}
          onCreated={(s) => {
            setSchedules((all) => [...(all ?? []), s]);
            setAdding(false);
          }}
        />
      ) : (
        <div className="actions">
          <button type="button" className="button button-secondary" onClick={() => setAdding(true)} disabled={blocked || suite.entryCount === 0}>
            <Icon name="plus" />
            Add a schedule
          </button>
        </div>
      )}
    </section>
  );
}

function ScheduleRow({
  schedule: s,
  blocked,
  onChange,
  onDeleted,
}: {
  schedule: ScheduleView;
  blocked: boolean;
  onChange: (s: ScheduleView) => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="schedule-row">
      <div className="stack-tight">
        <span>
          <strong>{describeCron(s.cron)}</strong> <span className="muted">({s.timezone})</span>
        </span>
        <span className="muted">
          {s.enabled && s.nextRunAt ? (
            <>
              Next run <time dateTime={s.nextRunAt}>{formatWhen(s.nextRunAt)}</time>
            </>
          ) : (
            "Paused"
          )}
          {s.lastFiredAt && s.lastOutcome && (
            <>
              {" · last time "}
              {s.lastSuiteRunId && s.lastOutcome === "started" ? (
                <a href={`/suite-runs/${encodeURIComponent(s.lastSuiteRunId)}`}>{OUTCOME_TEXT[s.lastOutcome]}</a>
              ) : (
                OUTCOME_TEXT[s.lastOutcome]
              )}
              {s.lastError ? ` (${s.lastError})` : ""}
            </>
          )}
          {s.createdBy ? ` · runs as ${s.createdBy.name}` : ""}
        </span>
        {error && (
          <span role="alert" className="field-error">
            <Icon name="error" /> {error}
          </span>
        )}
      </div>
      <div className="actions">
        <button
          type="button"
          className="button button-quiet"
          disabled={busy || (!s.enabled && blocked)}
          onClick={() => void act(async () => onChange(await updateSchedule(s.id, { cron: s.cron, timezone: s.timezone, enabled: !s.enabled })))}
        >
          {s.enabled ? "Pause" : "Resume"}
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={busy}
          aria-label={`Delete the schedule “${describeCron(s.cron)}”`}
          onClick={() =>
            void act(async () => {
              await deleteSchedule(s.id);
              onDeleted();
            })
          }
        >
          Delete
        </button>
      </div>
    </li>
  );
}

function NewSchedule({ suiteId, onCancel, onCreated }: { suiteId: string; onCancel: () => void; onCreated: (s: ScheduleView) => void }) {
  const [preset, setPreset] = useState<Preset>("weekdays");
  const [time, setTime] = useState("09:00");
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [timezone, setTimezone] = useState(browserTimeZone);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const expression = preset === "custom" ? cron.trim() : presetCron(preset, time);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      onCreated(await createSchedule(suiteId, { cron: expression, timezone: timezone.trim() }));
    } catch (err) {
      setError(err instanceof ApiRequestError && err.issues?.length ? err.issues[0]!.message : messageOf(err, "The schedule couldn't be added."));
      setPending(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit} noValidate aria-busy={pending} aria-label="New schedule">
      <div className="field">
        <label htmlFor="schedule-preset">When</label>
        <select id="schedule-preset" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
          {(Object.keys(PRESET_LABEL) as Preset[]).map((p) => (
            <option key={p} value={p}>
              {PRESET_LABEL[p]}
            </option>
          ))}
        </select>
      </div>
      {(preset === "daily" || preset === "weekdays") && (
        <div className="field">
          <label htmlFor="schedule-time">Time</label>
          <input id="schedule-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
      )}
      {preset === "custom" && (
        <div className="field">
          <label htmlFor="schedule-cron">Cron expression</label>
          <input id="schedule-cron" className="mono" value={cron} onChange={(e) => setCron(e.target.value)} />
          <p className="hint">Five fields: minute hour day-of-month month day-of-week.</p>
        </div>
      )}
      <div className="field">
        <label htmlFor="schedule-timezone">Time zone</label>
        <input id="schedule-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
      </div>
      {error && (
        <p role="alert" className="field-error">
          <Icon name="error" /> {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="button button-primary" disabled={pending}>
          {pending ? "Adding…" : "Add schedule"}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
