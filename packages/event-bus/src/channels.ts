/** Redis pub/sub channel names. The database is the source of truth; Redis is only the live path. */
export const runEventsChannel = (runId: string) => `run-events:${runId}`;
export const runCancelChannel = (runId: string) => `run-cancel:${runId}`;
/** Pending questions expire with their wait; answers are retained until consumed, so pub/sub loss is harmless (2026-11-21). */
export const runAssistChannel = (runId: string) => `run-assist:${runId}`;
export const runAssistKey = (runId: string) => `run-assist-pending:${runId}`;
export const runAssistAnswerKey = (runId: string, requestId: string) => `run-assist-answer:${runId}:${requestId}`;
export const RUN_EVENTS_PATTERN = "run-events:*";
