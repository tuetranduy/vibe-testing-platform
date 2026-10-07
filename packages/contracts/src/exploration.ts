import { z } from "zod";
import { CheckpointSchema, CriterionIdSchema, FactKeySchema, IsoDateTime } from "./common";
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

/**
 * A model's judgment of an unclear (`semantic`) criterion from what the exploration saw (2026-10-07): the page's text
 * and its screenshot where the criterion's subject is shown. Decides the criterion's status (verifier, rule 4).
 */
export const CriterionJudgmentSchema = z.object({
  criterionId: CriterionIdSchema,
  /** The page showed what the criterion is about, as the requirement means it. False: nothing to judge it on. */
  relevant: z.boolean(),
  verdict: z.enum(["HOLDS", "DOES_NOT_HOLD", "CANNOT_TELL"]),
  /** What the page actually showed for it: the actual result. */
  observed: z.string().max(1000),
  /** Why: how the requirement's words were read, and what on the page decided it. */
  reasoning: z.string().max(1000),
});
export type CriterionJudgment = z.infer<typeof CriterionJudgmentSchema>;

export const ExplorationStepSchema = z.object({
  id: z.string(),
  runId: z.string(),
  index: z.number().int().min(0),
  plannedStepId: z.string().nullable(),
  kind: z.enum(["navigate", "act", "fill", "observe", "extract", "checkpoint", "screenshot", "judge"]),
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
  /** The scenario the step ran in (V1.1 F9); absent on steps recorded before V1.1: SC-1. */
  scenarioId: z.string().regex(/^SC-[1-5]$/).optional(),
  /**
   * The value a fill typed that nobody provided: generated from the field for its `inputRef` (test data or a secret,
   * 2026-10-07). Absent or null: the value was provided (or the step is not a fill).
   */
  generatedValue: z.string().max(1000).nullable().optional(),
  /** A `judge` step's judgment (2026-10-07); absent on every other step, and on a judge step that failed. */
  judgment: CriterionJudgmentSchema.optional(),
});
export type ExplorationStep = z.infer<typeof ExplorationStepSchema>;

/** A value the run generated because nobody provided it (2026-10-07), with the first fill step that typed it. */
export const GeneratedInputSchema = z.object({
  source: z.enum(["testData", "secret"]),
  key: z.string().min(1).max(200),
  value: z.string().max(1000),
  stepId: z.string(),
});
export type GeneratedInput = z.infer<typeof GeneratedInputSchema>;

/** A step's scenario (SC-1 for steps recorded before V1.1). */
export const stepScenario = (step: Pick<ExplorationStep, "scenarioId">): string => step.scenarioId ?? "SC-1";

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
        /** text_list only: a CSS selector read inside each list row instead of the whole row (KI-001). */
        itemSelector: z.string().min(1).max(500).optional(),
      })
      .refine((r) => r.itemSelector === undefined || r.mode === "text_list", {
        message: "itemSelector goes only with text_list reads",
        path: ["itemSelector"],
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
  /**
   * What the element did when it was cached (tag, type, link target, form action; KI-032). A hit whose element now
   * does something else is a miss. Absent on entries written before it: those are misses, rewritten on success.
   */
  action: z.string().max(4000).optional(),
});
export type CachedElement = z.infer<typeof CachedElementSchema>;
