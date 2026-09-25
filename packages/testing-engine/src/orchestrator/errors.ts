import type { ErrorCategory } from "@platform/contracts";

/** Base for typed engine errors; `category` is what ERRORED runs record. */
export abstract class EngineError extends Error {
  abstract readonly category: ErrorCategory;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ModelProviderError extends EngineError {
  readonly category = "MODEL_PROVIDER" as const;
}
export class BrowserProviderError extends EngineError {
  readonly category = "BROWSER_PROVIDER" as const;
}
export class StorageError extends EngineError {
  readonly category = "STORAGE" as const;
}
export class ContractError extends EngineError {
  readonly category = "CONTRACT" as const;
}
export class DeadlineExceededError extends EngineError {
  readonly category = "TIMEOUT" as const;
  constructor(message = "Hard deadline exceeded") {
    super(message);
  }
}

/** Not an error category: cancellation ends the run as CANCELLED. */
export class CancelledError extends Error {
  constructor(message = "Run cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

/** Map any thrown value to an ErrorCategory. Unknown errors are INTERNAL. */
export function errorCategoryOf(err: unknown): ErrorCategory {
  if (err instanceof EngineError) return err.category;
  // Structural match so errors from other packages (e.g. @platform/storage StorageError) map too.
  const name = (err as { name?: string } | null)?.name;
  if (name === "StorageError") return "STORAGE";
  if (name === "ZodError") return "CONTRACT";
  return "INTERNAL";
}

/** A user-safe, bounded error message (no stack). */
export function errorMessageOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 1000);
}
