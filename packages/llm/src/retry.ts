export interface RetryPolicy {
  /** Retries after the first attempt (so at most maxRetries + 1 requests). */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 2, baseDelayMs: 1000, maxDelayMs: 20_000 };

/** Exponential backoff (base, 2·base, …), stretched to the provider's retry-after hint, capped. */
export function backoffMs(policy: RetryPolicy, retryIndex: number, retryAfterMs?: number): number {
  const exp = policy.baseDelayMs * 2 ** retryIndex;
  return Math.min(policy.maxDelayMs, Math.max(exp, retryAfterMs ?? 0));
}

/** setTimeout that rejects with the signal's reason when aborted. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
