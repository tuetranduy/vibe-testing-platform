/**
 * An error as the worker log records it (final review, Ruling R45): name and message only, passed
 * through the run's redactor (secret values), bounded. The run itself records a template message.
 */
export function redactedCause(err: unknown, redact: (value: unknown) => unknown): { name: string; message: string } {
  const e = err instanceof Error ? err : new Error(String(err));
  return { name: e.name, message: String(redact(e.message)).slice(0, 4_000) };
}

/** Receives the cause of a failure the run degrades from (rerun infrastructure, test generation). */
export interface FailureLogger {
  error(obj: object, msg?: string): void;
}
