import { z } from "zod";
import { CheckpointSchema, CriterionIdSchema, FactKeySchema, IsoDateTime } from "./common";
import { ArtifactSensitivitySchema, ArtifactTypeSchema, RerunOutcomeSchema, StatusReasonSchema } from "./results";
import {
  BlockReasonSchema,
  CancelReasonSchema,
  CriterionStatusSchema,
  ErrorCategorySchema,
  RunLifecycleSchema,
  RunVerdictSchema,
} from "./run";
import { ExplorationStepSchema } from "./exploration";

const envelope = {
  id: z.string(),
  runId: z.string(),
  sequence: z.number().int().positive(),
  timestamp: IsoDateTime,
  stage: RunLifecycleSchema, // lifecycle at publish time
  message: z.string().max(300), // template-built, shown in the UI timeline
};

const ev = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({ ...envelope, type: z.literal(type), payload });

const StagePayload = z.object({ stage: RunLifecycleSchema });

export const TestEventSchema = z.discriminatedUnion("type", [
  ev("run.created", z.object({ targetHost: z.string() })),
  ev("stage.started", StagePayload),
  ev("stage.completed", StagePayload),
  ev("stage.skipped", StagePayload),
  ev(
    "criteria.proposed",
    z.object({
      revision: z.number().int().min(1),
      criteria: z.array(z.object({ id: CriterionIdSchema, statement: z.string(), ambiguous: z.boolean() })),
    }),
  ),
  ev("criteria.updated", z.object({ revision: z.number().int().min(1) })),
  ev("criteria.confirmed", z.object({ revision: z.number().int().min(1) })),
  ev(
    "plan.created",
    z.object({
      stepCount: z.number().int().min(0),
      blockedCriteria: z.array(z.object({ criterionId: CriterionIdSchema, reason: BlockReasonSchema })),
    }),
  ),
  ev(
    "step.recorded",
    z.object({
      stepId: z.string(),
      index: z.number().int().min(0),
      kind: ExplorationStepSchema.shape.kind,
      outcome: ExplorationStepSchema.shape.outcome,
      blockReason: BlockReasonSchema.nullable(),
    }),
  ),
  // No value — values can be personal data.
  ev(
    "fact.observed",
    z.object({ key: FactKeySchema, checkpoint: CheckpointSchema, provenance: z.enum(["DOM_VERIFIED", "MODEL_EXTRACTED"]) }),
  ),
  ev(
    "criterion.evaluated",
    z.object({
      criterionId: CriterionIdSchema,
      status: CriterionStatusSchema,
      reason: StatusReasonSchema.nullable(),
      provisional: z.boolean(),
    }),
  ),
  // No URL — signed URLs are fetched on demand.
  ev("artifact.created", z.object({ artifactId: z.string(), type: ArtifactTypeSchema, sensitivity: ArtifactSensitivitySchema })),
  ev("artifact.omitted", z.object({ type: ArtifactTypeSchema, reason: z.string().max(300) })),
  ev(
    "test.generated",
    z.object({
      compiledCriteria: z.array(CriterionIdSchema),
      notCompiled: z.array(z.object({ criterionId: CriterionIdSchema, reason: z.string() })),
    }),
  ),
  ev(
    "playwright.completed",
    z.object({
      status: z.enum(["PASSED", "FAILED", "ERRORED"]),
      durationMs: z.number().int(),
      // Each compiled criterion's rerun outcome (ids + enum only), so a partial report can still
      // reconcile against the rerun (Ruling R43). Defaulted: events persisted before it still parse.
      perCriterion: z.record(CriterionIdSchema, RerunOutcomeSchema).default({}),
    }),
  ),
  ev("egress.blocked", z.object({ host: z.string(), reason: z.string().max(300) })),
  ev("run.completed", z.object({ verdict: RunVerdictSchema })),
  ev("run.cancelled", z.object({ reason: CancelReasonSchema })),
  ev("run.errored", z.object({ category: ErrorCategorySchema, message: z.string().max(1000) })),
]);
export type TestEvent = z.infer<typeof TestEventSchema>;
export type TestEventType = TestEvent["type"];
export type TestEventOf<T extends TestEventType> = Extract<TestEvent, { type: T }>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What a publisher supplies; id, sequence and timestamp are assigned on persist. */
export type TestEventInput = DistributiveOmit<TestEvent, "id" | "sequence" | "timestamp">;

export const TEST_EVENT_TYPES = TestEventSchema.options.map((o) => o.shape.type.value) as TestEventType[];
export const TERMINAL_EVENT_TYPES = ["run.completed", "run.cancelled", "run.errored"] as const satisfies readonly TestEventType[];
export const isTerminalEvent = (e: { type: string }): boolean =>
  (TERMINAL_EVENT_TYPES as readonly string[]).includes(e.type);
