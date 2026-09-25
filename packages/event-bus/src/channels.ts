/** Redis pub/sub channel names. The database is the source of truth; Redis is only the live path. */
export const runEventsChannel = (runId: string) => `run-events:${runId}`;
export const runCancelChannel = (runId: string) => `run-cancel:${runId}`;
export const RUN_EVENTS_PATTERN = "run-events:*";
