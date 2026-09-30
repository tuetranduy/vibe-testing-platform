import { z } from "zod";
import { IsoDateTime } from "./common";
import { LlmProviderSchema } from "./llm";
import { RunLifecycleSchema } from "./run";

/** A UTC calendar day, `YYYY-MM-DD`. */
export const DaySchema = z.iso.date();

/** `GET /v1/usage` (V1.1 F7): the range is inclusive; default the last 30 days (UTC); at most 366 days. */
export const UsageQuerySchema = z
  .object({
    from: DaySchema.optional(),
    to: DaySchema.optional(),
    /** Administrators: `me` for their own runs; members always get their own. */
    owner: z.enum(["me", "all"]).optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from must not be after to", path: ["from"] });
export type UsageQuery = z.infer<typeof UsageQuerySchema>;

const Totals = { llmCalls: z.number().int(), inputTokens: z.number().int(), outputTokens: z.number().int(), estimatedCostUsd: z.number() };

/** Model spend over a date range, from the runs' recorded model calls. */
export const UsageReportSchema = z.object({
  from: DaySchema,
  to: DaySchema,
  scope: z.enum(["mine", "all"]),
  totals: z.object({ runs: z.number().int(), ...Totals }),
  /** Every day of the range, zeros included, oldest first. */
  byDay: z.array(z.object({ day: DaySchema, llmCalls: z.number().int(), estimatedCostUsd: z.number() })),
  byModel: z.array(z.object({ provider: LlmProviderSchema.or(z.string()), model: z.string(), label: z.string(), ...Totals })),
  byStage: z.array(z.object({ stage: RunLifecycleSchema, llmCalls: z.number().int(), estimatedCostUsd: z.number() })),
  /** The most expensive runs of the range (at most 10). */
  topRuns: z.array(
    z.object({
      runId: z.string(),
      targetUrl: z.string(),
      requirementPreview: z.string(),
      createdAt: IsoDateTime,
      owner: z.object({ id: z.string(), name: z.string() }).nullable(),
      llmCalls: z.number().int(),
      estimatedCostUsd: z.number(),
    }),
  ),
});
export type UsageReport = z.infer<typeof UsageReportSchema>;
