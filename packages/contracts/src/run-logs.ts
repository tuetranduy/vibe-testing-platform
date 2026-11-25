import { z } from "zod";
import { IsoDateTime } from "./common";
import { RunLifecycleSchema } from "./run";

/** Where a run's log line came from (admin run logs, 2026-11-25). */
export const RunLogSourceSchema = z.enum(["worker", "api", "runner", "browser_use", "infra", "web_app", "target_site"]);
export type RunLogSource = z.infer<typeof RunLogSourceSchema>;

export const RunLogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
export type RunLogLevel = z.infer<typeof RunLogLevelSchema>;

export const RunLogLineSchema = z.object({
  id: z.string(),
  time: IsoDateTime,
  source: RunLogSourceSchema,
  level: RunLogLevelSchema,
  stage: RunLifecycleSchema.nullable(),
  component: z.string(),
  message: z.string(),
  fields: z.record(z.string(), z.unknown()),
});
export type RunLogLine = z.infer<typeof RunLogLineSchema>;

const commaList = (value: unknown) =>
  typeof value === "string" ? value.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : value;

/** `GET /v1/test-runs/:runId/logs` query. `source` is comma-separated; `minLevel` keeps that level and above. */
export const RunLogQuerySchema = z.object({
  after: z.string().max(200).optional(),
  source: z.preprocess(commaList, z.array(RunLogSourceSchema).min(1)).optional(),
  minLevel: RunLogLevelSchema.optional(),
  stage: RunLifecycleSchema.optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
export type RunLogQuery = z.infer<typeof RunLogQuerySchema>;

export const RunLogPageSchema = z.object({
  lines: z.array(RunLogLineSchema),
  /** Set when more lines matched than `limit`: the next page starts here. */
  nextCursor: z.string().nullable(),
  /** After this page's last line (null when it is empty): what a live view polls from. */
  lastCursor: z.string().nullable(),
});
export type RunLogPage = z.infer<typeof RunLogPageSchema>;

export const LlmExchangeAvailabilitySchema = z.enum(["available", "expired", "none"]);

export const LlmCallViewSchema = z.object({
  id: z.string(),
  time: IsoDateTime,
  stage: RunLifecycleSchema,
  purpose: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  estimatedCostUsd: z.number(),
  latencyMs: z.number().int(),
  status: z.string(),
  exchange: LlmExchangeAvailabilitySchema,
});
export type LlmCallView = z.infer<typeof LlmCallViewSchema>;

export const RunLlmCallsSchema = z.object({
  calls: z.array(LlmCallViewSchema),
  totals: z.object({
    calls: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    estimatedCostUsd: z.number(),
  }),
});
export type RunLlmCalls = z.infer<typeof RunLlmCallsSchema>;

/** One model call's request as sent (after the run redactor) and its answer. */
export const LlmExchangeSchema = z.object({
  system: z.string(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.unknown() })),
  response: z.string().nullable(),
  error: z.string().nullable(),
  truncated: z.boolean(),
});
export type LlmExchange = z.infer<typeof LlmExchangeSchema>;

export const ClientLogLineSchema = z.object({
  time: IsoDateTime,
  level: z.enum(["warn", "error"]),
  message: z.string().max(4096),
  url: z.string().max(2048),
  kind: z.enum(["error", "unhandledrejection", "render", "api"]),
  stack: z.string().max(16384).optional(),
});
export type ClientLogLine = z.infer<typeof ClientLogLineSchema>;

/** `POST /v1/test-runs/:runId/client-logs`: our web app's frontend errors while a run's pages are open. */
export const ClientLogBatchSchema = z.object({ lines: z.array(ClientLogLineSchema).min(1).max(50) });
export type ClientLogBatch = z.infer<typeof ClientLogBatchSchema>;
