import type { RunLifecycle, TestEvent, TestEventOf, TestEventType } from "@platform/contracts";

/** Builds a typed TestEvent for tests; `stage` defaults to the payload's stage when it has one. */
export function ev<T extends TestEventType>(
  sequence: number,
  type: T,
  payload: TestEventOf<T>["payload"],
  opts: { stage?: RunLifecycle; message?: string; runId?: string } = {},
): TestEvent {
  const payloadStage = (payload as { stage?: RunLifecycle }).stage;
  return {
    id: `evt_${sequence}`,
    runId: opts.runId ?? "run_1",
    sequence,
    timestamp: new Date(Date.UTC(2026, 8, 26, 10, 0, sequence)).toISOString(),
    stage: opts.stage ?? payloadStage ?? "PLANNING",
    message: opts.message ?? `${type} #${sequence}`,
    type,
    payload,
  } as TestEvent;
}

/** One server-sent event frame, as the API writes it. */
export const sseFrame = (e: TestEvent) => `id: ${e.sequence}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
