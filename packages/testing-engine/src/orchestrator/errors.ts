import { EngineError, type ErrorCategory } from "@platform/contracts";

// The error classes are defined in @platform/contracts so @platform/llm can throw them too.
export {
  BrowserProviderError,
  CancelledError,
  ContractError,
  DeadlineExceededError,
  EngineError,
  ModelProviderError,
  StorageError,
} from "@platform/contracts";

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
