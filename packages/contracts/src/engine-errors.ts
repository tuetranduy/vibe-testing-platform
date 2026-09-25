import type { ErrorCategory } from "./run";

/**
 * Typed engine errors. They live here (not in @platform/testing-engine) so that lower-level
 * packages such as @platform/llm can throw them without depending on the engine.
 * `category` is what ERRORED runs record.
 */
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
