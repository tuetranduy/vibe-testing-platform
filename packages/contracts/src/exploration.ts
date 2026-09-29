import { z } from "zod";
import { CheckpointSchema, FactKeySchema, IsoDateTime } from "./common";
import { InputRefSchema } from "./plan";
import { BlockReasonSchema } from "./run";

export const LocatorCandidateSchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("role"), role: z.string(), name: z.string(), exact: z.boolean() }),
  z.object({ strategy: z.literal("label"), text: z.string() }),
  z.object({ strategy: z.literal("placeholder"), text: z.string() }),
  z.object({ strategy: z.literal("text"), text: z.string(), exact: z.boolean() }),
  z.object({ strategy: z.literal("testId"), value: z.string() }),
  z.object({ strategy: z.literal("css"), selector: z.string() }),
  z.object({ strategy: z.literal("xpath"), selector: z.string() }),
]);
export type LocatorCandidate = z.infer<typeof LocatorCandidateSchema>;

export const ElementRefSchema = z
  .object({
    candidates: z.array(LocatorCandidateSchema).min(1), // ordered by locator policy
    chosenIndex: z.number().int().min(0), // first candidate that matched exactly one element
    framePath: z.array(z.string()).default([]), // [] = main frame
  })
  .refine((e) => e.chosenIndex < e.candidates.length, {
    message: "chosenIndex out of range",
    path: ["chosenIndex"],
  });
export type ElementRef = z.infer<typeof ElementRefSchema>;

export const LlmStepUsageSchema = z.object({
  model: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheHit: z.boolean().nullable(),
});

export const ExplorationStepSchema = z.object({
  id: z.string(),
  runId: z.string(),
  index: z.number().int().min(0),
  plannedStepId: z.string().nullable(),
  kind: z.enum(["navigate", "act", "fill", "observe", "extract", "checkpoint", "screenshot"]),
  instruction: z.string().max(1000), // redacted
  element: ElementRefSchema.nullable(),
  inputRef: InputRefSchema.nullable(),
  onGoldenPath: z.boolean(), // true = part of the successful flow the compiler replays
  urlBefore: z.string(),
  urlAfter: z.string(),
  outcome: z.enum(["SUCCESS", "FAILED", "BLOCKED_BY_POLICY"]),
  blockReason: BlockReasonSchema.nullable(),
  error: z.string().max(2000).nullable(),
  startedAt: IsoDateTime,
  durationMs: z.number().int().min(0),
  artifactIds: z.array(z.string()),
  llm: LlmStepUsageSchema.nullable(),
});
export type ExplorationStep = z.infer<typeof ExplorationStepSchema>;

export const FactValueSchema = z.union([z.boolean(), z.number(), z.string(), z.array(z.string()), z.null()]);
export type FactValue = z.infer<typeof FactValueSchema>;

export const ObservedFactSchema = z
  .object({
    key: FactKeySchema,
    checkpoint: CheckpointSchema,
    value: FactValueSchema,
    provenance: z.enum(["DOM_VERIFIED", "MODEL_EXTRACTED"]),
    read: z
      .object({
        element: ElementRefSchema,
        mode: z.enum(["text", "number", "visible", "count", "value", "text_list"]),
      })
      .nullable(), // required when provenance = DOM_VERIFIED (except key "url")
    modelValue: FactValueSchema.optional(), // what the model extracted, kept for audit
    domValue: FactValueSchema.optional(), // the DOM reading when it disagreed with the model (MODEL_EXTRACTED), kept for audit
    stepId: z.string(),
  })
  .refine((f) => f.provenance !== "DOM_VERIFIED" || f.key === "url" || f.read !== null, {
    message: "DOM_VERIFIED facts must record how they were read",
    path: ["read"],
  });
export type ObservedFact = z.infer<typeof ObservedFactSchema>;

/**
 * An element lookup verified on an earlier run (V1.1 F8): the selector the explorer found, and the locator
 * the recorder chose for it then. Reused only when the selector still matches exactly one element whose
 * chosen locator is the same.
 */
export const CachedElementSchema = z.object({
  selector: z.string().min(1).max(2000),
  description: z.string().max(1000),
  method: z.string().max(40).nullable(),
  element: ElementRefSchema,
});
export type CachedElement = z.infer<typeof CachedElementSchema>;
