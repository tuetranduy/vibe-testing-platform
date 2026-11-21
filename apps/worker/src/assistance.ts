import { runAssistAnswerKey, runAssistChannel, runAssistKey } from "@platform/event-bus";
import { DEFAULT_ASSISTANCE_TIMEOUT_MS, type AssistancePort, type AssistanceAnswer } from "@platform/testing-engine";
import type { Redis } from "ioredis";

/**
 * Redis holds transient coordination, while requested/answered events remain the audit record (2026-11-21).
 * Prepare pending state before the request event, then subscribe and poll the retained answer so reconnects lose none.
 * A dedicated subscriber is released after every wait; the main connection must remain usable for commands.
 */
export function createAssistancePort(redis: Redis, runId: string, timeoutMs = DEFAULT_ASSISTANCE_TIMEOUT_MS): AssistancePort {
  let prepared: string | undefined;
  const prepare: NonNullable<AssistancePort["prepare"]> = async (request, signal) => {
    signal.throwIfAborted();
    await redis.set(runAssistKey(runId), JSON.stringify(request), "PX", Math.max(1, Date.parse(request.expiresAt) - Date.now()));
    prepared = request.requestId;
  };
  return {
    timeoutMs,
    prepare,
    async ask(request, signal) {
      signal.throwIfAborted();
      const subscriber = redis.duplicate();
      const channel = runAssistChannel(runId);
      const key = runAssistKey(runId);
      const answerKey = runAssistAnswerKey(runId, request.requestId);
      let wake: (() => void) | undefined;
      subscriber.on("message", () => wake?.());
      const onAbort = () => wake?.();
      signal.addEventListener("abort", onAbort);
      try {
        await subscriber.subscribe(channel);
        if (prepared !== request.requestId) await prepare(request, signal);
        while (Date.now() < Date.parse(request.expiresAt)) {
          signal.throwIfAborted();
          const raw = await redis.get(answerKey);
          if (raw) return JSON.parse(raw) as AssistanceAnswer;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.min(500, Math.max(1, Date.parse(request.expiresAt) - Date.now())));
            wake = () => { clearTimeout(timer); resolve(); };
            if (signal.aborted) wake();
          });
        }
        signal.throwIfAborted();
        const last = await redis.get(answerKey);
        return last ? JSON.parse(last) as AssistanceAnswer : { kind: "timeout" };
      } finally {
        signal.removeEventListener("abort", onAbort);
        subscriber.disconnect();
        await redis.del(key, answerKey);
      }
    },
  };
}

/** Bad deployment settings must not create an unbounded wait (2026-11-21). */
export function assistanceTimeoutMs(): number {
  const ms = Number(process.env.ASSISTANCE_TIMEOUT_MS ?? DEFAULT_ASSISTANCE_TIMEOUT_MS);
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > 86_400_000) throw new Error("ASSISTANCE_TIMEOUT_MS must be between 1 and 86400000");
  return ms;
}
