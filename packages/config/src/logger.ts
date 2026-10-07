import { redactByKey } from "@platform/security";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFn = (obj: object, msg?: string) => void;

export interface Logger {
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  /** A logger whose lines also carry `bindings`; a line's own fields win. */
  child(bindings: Record<string, unknown>): Logger;
}

/** What a run's log lines carry, and how they are redacted, while the run is active in this process. */
export interface RunLogScope {
  tenantId: string;
  stage: string;
  /** The run's redactor, applied after key-based redaction (key-based too since 2026-10-07: secret values are kept). */
  redact: (value: unknown) => unknown;
}

/**
 * Active runs of this process, by id. The worker's run context registers a run with its redactor
 * (built from the run's decrypted secrets) and keeps its stage current; every line that names the
 * run (`runId`) is then enriched and redacted, whichever component wrote it.
 */
export interface RunLogRegistry {
  /** Returns the release function; releasing an older registration never removes a newer one. */
  register(runId: string, scope: RunLogScope): () => void;
  setStage(runId: string, stage: string): void;
  get(runId: string): RunLogScope | undefined;
  readonly size: number;
}

export function createRunLogRegistry(): RunLogRegistry {
  const scopes = new Map<string, RunLogScope>();
  return {
    register(runId, scope) {
      const entry = { ...scope };
      scopes.set(runId, entry);
      return () => {
        if (scopes.get(runId) === entry) scopes.delete(runId);
      };
    },
    setStage(runId, stage) {
      const scope = scopes.get(runId);
      if (scope) scope.stage = stage;
    },
    get: (runId) => scopes.get(runId),
    get size() {
      return scopes.size;
    },
  };
}

export interface LoggerOptions {
  component: string;
  level?: LogLevel;
  runs?: RunLogRegistry;
  /** Receives each line (no trailing newline). Default: stdout. */
  write?: (line: string) => void;
  now?: () => Date;
}

/** How many `cause` links a logged error keeps. */
const MAX_CAUSE_DEPTH = 5;

/**
 * An error as a plain object: name, message, code, stack and its `cause` chain (a cause that is
 * not an Error is kept as a value). The line's redaction then applies to all of it, stack included.
 */
function serializeError(err: unknown, chain: unknown[] = []): unknown {
  if (!(err instanceof Error)) return err;
  const out: Record<string, unknown> = { name: err.name, message: err.message };
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") out.code = code;
  if (typeof err.stack === "string") out.stack = err.stack;
  if (err.cause !== undefined) {
    const next = [...chain, err];
    if (next.includes(err.cause)) out.cause = "[Circular]";
    else if (next.length > MAX_CAUSE_DEPTH) out.cause = "[Truncated]";
    else out.cause = serializeError(err.cause, next);
  }
  return out;
}

/**
 * JSON that never throws: a value inside itself (a cycle) becomes "[Circular]", BigInts strings.
 * A value referenced twice is written twice: only the path from the root to a value is checked.
 */
function stringify(value: unknown): string {
  const ancestors: object[] = [];
  return JSON.stringify(value, function (this: unknown, _key, v: unknown) {
    if (typeof v === "bigint") return v.toString();
    if (v === null || typeof v !== "object") return v;
    // `this` is the object holding `v`: leave the branches JSON.stringify has finished.
    while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();
    if (ancestors.includes(v)) return "[Circular]";
    ancestors.push(v);
    return v;
  });
}

/**
 * JSON-lines logger for the API and worker processes. Every line: key-based redaction
 * (`redactByKey`), then — when the line names a registered run — `tenantId` / `stage` from the run
 * scope and the run's own redactor.
 */
export function createLogger(opts: LoggerOptions, bindings: Record<string, unknown> = {}): Logger {
  const min = LOG_LEVELS.indexOf(opts.level ?? "info");
  const write = opts.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const now = opts.now ?? (() => new Date());

  const at =
    (level: LogLevel): LogFn =>
    (obj, msg) => {
      if (LOG_LEVELS.indexOf(level) < min) return;
      try {
        const fields: Record<string, unknown> = { ...bindings, ...(obj as Record<string, unknown>) };
        if ("err" in fields) fields.err = serializeError(fields.err);
        const scope = typeof fields.runId === "string" ? opts.runs?.get(fields.runId) : undefined;
        if (scope) {
          fields.tenantId ??= scope.tenantId;
          fields.stage ??= scope.stage;
        }
        let record = redactByKey({ component: opts.component, ...fields, msg }) as object;
        if (scope) record = scope.redact(record) as object;
        write(stringify({ level, time: now().toISOString(), ...record }));
      } catch (err) {
        write(
          JSON.stringify({
            level: "error",
            time: now().toISOString(),
            component: opts.component,
            msg: "log line could not be written",
            err: err instanceof Error ? err.name : "unknown",
          }),
        );
      }
    };

  return {
    trace: at("trace"),
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    fatal: at("fatal"),
    child: (more) => createLogger(opts, { ...bindings, ...more }),
  };
}
