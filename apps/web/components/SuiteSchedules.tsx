"use client";

import { Field } from "@/components/ui/field";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
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
  skipped_late: "skipped: it was due while the platform was down",
  failed: "failed",
};

const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/** Scheduled replay is available for tests using the current setup flow. */
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
  const blocked = suite.secretNames.length > 0;

  return (
    <Card as="section" className="flex min-w-0 flex-col gap-5" aria-labelledby="schedules-title">
      <div className="flex flex-col gap-1.5 [&>.text-muted-foreground]:max-w-[68ch]">
        <h2 id="schedules-title" className="card-title mb-3.5 text-sm font-semibold text-muted-foreground">
          <Icon name="clock" /> Schedules
        </h2>
        <p className="text-muted-foreground">The suite runs by itself at these times, as the person who added the schedule.</p>
      </div>
      {blocked && (
        <p className="hint text-[0.8125rem] text-(--text-subtle) [&_.icon]:mr-0.5">
          Some tests use an older setup. Replace them with fresh tests before adding a schedule.
        </p>
      )}
      {loadError && (
        <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-destructive [&_.icon]:mt-px">
          <Icon name="error" /> Schedules couldn&apos;t be loaded: {loadError}
        </p>
      )}
      {schedules && schedules.length === 0 && !adding && <p className="text-muted-foreground">No schedules.</p>}
      {schedules && schedules.length > 0 && (
        <ul className="m-0 grid list-none gap-2.5 p-0 [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:gap-x-3.5 [&>li]:gap-y-2" aria-label="Schedules">
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
        <div className="actions flex flex-wrap items-center gap-2">
          <Button variant="outline" type="button" onClick={() => setAdding(true)} disabled={blocked || suite.entryCount === 0}>
            <Icon name="plus" />
            Add a schedule
          </Button>
        </div>
      )}
    </Card>
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
    <li className="justify-between border-t border-(--border-soft) py-2.5 first:border-t-0">
      <div className="stack-tight flex min-w-0 flex-col gap-3">
        <span>
          <strong>{describeCron(s.cron)}</strong> <span className="text-muted-foreground">({s.timezone})</span>
        </span>
        <span className="text-muted-foreground">
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
          <span role="alert" className="flex items-start gap-1.5 text-sm font-medium text-destructive [&_.icon]:mt-px">
            <Icon name="error" /> {error}
          </span>
        )}
      </div>
      <div className="actions flex flex-wrap items-center gap-2">
        <Button variant="ghost"
          type="button"
          disabled={busy || (!s.enabled && blocked)}
          onClick={() => void act(async () => onChange(await updateSchedule(s.id, { cron: s.cron, timezone: s.timezone, enabled: !s.enabled })))}
        >
          {s.enabled ? "Pause" : "Resume"}
        </Button>
        <Button variant="ghost"
          type="button"
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
        </Button>
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
    <form className="flex min-w-0 flex-col gap-5" onSubmit={submit} noValidate aria-busy={pending} aria-label="New schedule">
      <Field>
        <label htmlFor="schedule-preset">When</label>
        <NativeSelect id="schedule-preset" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
          {(Object.keys(PRESET_LABEL) as Preset[]).map((p) => (
            <option key={p} value={p}>
              {PRESET_LABEL[p]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {(preset === "daily" || preset === "weekdays") && (
        <Field>
          <label htmlFor="schedule-time">Time</label>
          <Input id="schedule-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </Field>
      )}
      {preset === "custom" && (
        <Field>
          <label htmlFor="schedule-cron">Cron expression</label>
          <Input id="schedule-cron" className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} />
          <p className="hint text-[0.8125rem] text-(--text-subtle) [&_.icon]:mr-0.5">Five fields: minute hour day-of-month month day-of-week.</p>
        </Field>
      )}
      <Field>
        <label htmlFor="schedule-timezone">Time zone</label>
        <Input id="schedule-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
      </Field>
      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-destructive [&_.icon]:mt-px">
          <Icon name="error" /> {error}
        </p>
      )}
      <div className="actions flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add schedule"}
        </Button>
        <Button variant="outline" type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
