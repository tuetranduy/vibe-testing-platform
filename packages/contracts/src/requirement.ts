import { z } from "zod";
import {
  CheckpointSchema,
  CriterionIdSchema,
  DataKeySchema,
  FactKeySchema,
  FactRefSchema,
  IsoDateTime,
  URL_FACT_KEY,
  type FactRef,
} from "./common";

/**
 * What a text check compares with: a literal `value`, or the run's value for a test data key (`testDataKey`, KI-001:
 * "the account page shows the user's email" — the model sees test data keys, never their values). Exactly one; a
 * regex is always a literal. `resolveTestDataValues` turns a key into its value before a check is evaluated.
 */
export const TextMatchSchema = z
  .object({
    mode: z.enum(["equals", "contains", "regex"]),
    value: z.string().min(1).max(500).optional(),
    testDataKey: DataKeySchema.optional(),
    caseSensitive: z.boolean().default(false),
  })
  .refine((m) => (m.value === undefined) !== (m.testDataKey === undefined), {
    message: "A text check compares with either a value or a test data key",
    path: ["value"],
  })
  .refine((m) => m.mode !== "regex" || m.testDataKey === undefined, {
    message: "A regular expression is always written out, never taken from test data",
    path: ["testDataKey"],
  });
export type TextMatch = z.infer<typeof TextMatchSchema>;

export const ExpectedOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("visible"), fact: FactRefSchema, expected: z.boolean().default(true) }),
  z.object({ kind: z.literal("text_matches"), fact: FactRefSchema, match: TextMatchSchema }),
  z.object({
    kind: z.literal("numeric_compare"),
    left: FactRefSchema,
    operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]),
    right: z.union([FactRefSchema, z.number()]),
  }),
  z.object({ kind: z.literal("numeric_delta"), before: FactRefSchema, after: FactRefSchema, delta: z.number() }),
  z.object({
    kind: z.literal("collection_contains"),
    collection: FactRefSchema,
    item: z.union([FactRefSchema, z.string().min(1)]),
    match: z.enum(["equals", "contains"]).default("contains"),
  }),
  z.object({ kind: z.literal("semantic"), description: z.string().min(3).max(1000) }),
]);
export type ExpectedOutcome = z.infer<typeof ExpectedOutcomeSchema>;

export const FactRequestSchema = z.object({
  key: FactKeySchema,
  checkpoint: CheckpointSchema,
  description: z.string().min(3).max(500),
  valueType: z.enum(["boolean", "number", "string", "string_list"]),
});
export type FactRequest = z.infer<typeof FactRequestSchema>;

export const PreconditionSchema = z.object({
  kind: z.enum(["authenticated", "test_data", "secret"]),
  ref: z.string().optional(), // testData key or secret name
  description: z.string().max(500),
});
export type Precondition = z.infer<typeof PreconditionSchema>;

export const AcceptanceCriterionSchema = z.object({
  id: CriterionIdSchema,
  sourceText: z.string().min(1), // verbatim substring of originalText
  statement: z.string().min(3).max(1000),
  expectedOutcome: ExpectedOutcomeSchema,
  preconditions: z.array(PreconditionSchema).default([]),
  /**
   * V1.1 (D4 amended): only critical criteria decide the run's verdict; a non-critical one is reported with its
   * status and never changes the verdict. Always true from the model; the user changes it in review.
   */
  critical: z.boolean().default(true),
  ambiguity: z
    .object({
      reason: z.string().max(500),
      suggestions: z.array(z.string().max(300)).max(3),
    })
    .nullable(),
  /**
   * 2026-11-11: `stated` comes from the requirement's own words; `inferred` was added by the analysis because the
   * requirement is short or vague (and the pages read show what it checks). Both quote the requirement in
   * `sourceText`; an inferred one says why it was added in `rationale`.
   */
  origin: z.enum(["stated", "inferred"]).optional(),
  rationale: z.string().min(3).max(300).nullable().optional(),
  /** A vague phrase checked in a concrete way: what the analysis assumed it means. Cleared when the user edits the check. */
  assumption: z.string().min(3).max(300).nullable().optional(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

/** Absent on criteria stored before 2026-11-11: those are all stated. */
export const isInferred = (c: Pick<AcceptanceCriterion, "origin">): boolean => c.origin === "inferred";

/** A requirement's inferred criteria are capped: they expand what the user wrote, they do not replace it. */
export const MAX_INFERRED_CRITERIA = 5;

/**
 * What the analysis understood the user wants to test (2026-11-11, spec intent-understanding). `notes` are the
 * things it did on its own that belong to no single criterion (e.g. a criterion it left out).
 */
export const RequirementIntentSchema = z.object({
  clarity: z.enum(["specific", "feature", "vague", "site_wide"]),
  /** One sentence: what the user wants to know. */
  goal: z.string().min(3).max(300),
  /** The feature under test as the site names it ("Search", "Wishlist"), when there is one. */
  feature: z.string().min(1).max(80).nullable(),
  notes: z.array(z.string().max(300)).max(10).default([]),
});
export type RequirementIntent = z.infer<typeof RequirementIntentSchema>;

/** Every FactRef used by an expected outcome, with its path inside the outcome. */
export function factRefsOf(outcome: ExpectedOutcome): { ref: FactRef; path: string[] }[] {
  switch (outcome.kind) {
    case "visible":
    case "text_matches":
      return [{ ref: outcome.fact, path: ["fact"] }];
    case "numeric_compare":
      return [
        { ref: outcome.left, path: ["left"] },
        ...(typeof outcome.right === "number" ? [] : [{ ref: outcome.right, path: ["right"] }]),
      ];
    case "numeric_delta":
      return [
        { ref: outcome.before, path: ["before"] },
        { ref: outcome.after, path: ["after"] },
      ];
    case "collection_contains":
      return [
        { ref: outcome.collection, path: ["collection"] },
        ...(typeof outcome.item === "string" ? [] : [{ ref: outcome.item, path: ["item"] }]),
      ];
    case "semantic":
      return [];
  }
}

export const NormalizedRequirementSchema = z
  .object({
    runId: z.string(),
    revision: z.number().int().min(1),
    originalText: z.string(),
    title: z.string().trim().min(3).max(120).nullable().optional(),
    criteria: z.array(AcceptanceCriterionSchema).min(1).max(20),
    facts: z.array(FactRequestSchema).max(60),
    confirmedAt: IsoDateTime.nullable(),
    intent: RequirementIntentSchema.nullable().optional(),
  })
  .superRefine((req, ctx) => {
    // 0. the verdict needs something to decide it (V1.1)
    if (!req.criteria.some((c) => c.critical)) {
      ctx.addIssue({ code: "custom", path: ["criteria"], message: "Keep at least one critical criterion: only critical criteria decide the verdict" });
    }

    // 0b. where a criterion came from (2026-11-11)
    req.criteria.forEach((c, i) => {
      const rationale = c.rationale ?? null;
      if (isInferred(c) && rationale === null) {
        ctx.addIssue({ code: "custom", path: ["criteria", i, "rationale"], message: "An inferred criterion says why it was added" });
      }
      if (!isInferred(c) && rationale !== null) {
        ctx.addIssue({ code: "custom", path: ["criteria", i, "rationale"], message: "Only an inferred criterion has a rationale" });
      }
    });
    if (req.criteria.filter(isInferred).length > MAX_INFERRED_CRITERIA) {
      ctx.addIssue({ code: "custom", path: ["criteria"], message: `At most ${MAX_INFERRED_CRITERIA} inferred criteria` });
    }

    // 1. unique criterion ids
    const seenIds = new Set<string>();
    req.criteria.forEach((c, i) => {
      if (seenIds.has(c.id)) {
        ctx.addIssue({ code: "custom", path: ["criteria", i, "id"], message: `Duplicate criterion id ${c.id}` });
      }
      seenIds.add(c.id);
    });

    // 2. unique (key, checkpoint) pairs; "url" is reserved
    const declared = new Set<string>();
    const checkpoints = new Set<string>();
    req.facts.forEach((f, i) => {
      if (f.key === URL_FACT_KEY) {
        ctx.addIssue({ code: "custom", path: ["facts", i, "key"], message: `Fact key "${URL_FACT_KEY}" is reserved` });
      }
      const k = `${f.key}@${f.checkpoint}`;
      if (declared.has(k)) {
        ctx.addIssue({ code: "custom", path: ["facts", i], message: `Duplicate fact ${k}` });
      }
      declared.add(k);
      checkpoints.add(f.checkpoint);
    });

    req.criteria.forEach((c, i) => {
      // 3. every FactRef resolves
      for (const { ref, path } of factRefsOf(c.expectedOutcome)) {
        const ok =
          ref.key === URL_FACT_KEY ? checkpoints.has(ref.checkpoint) : declared.has(`${ref.key}@${ref.checkpoint}`);
        if (!ok) {
          ctx.addIssue({
            code: "custom",
            path: ["criteria", i, "expectedOutcome", ...path],
            message: `Fact ${ref.key}@${ref.checkpoint} is not declared`,
          });
        }
      }
      // 4. sourceText is verbatim
      if (!req.originalText.includes(c.sourceText)) {
        ctx.addIssue({
          code: "custom",
          path: ["criteria", i, "sourceText"],
          message: "sourceText must be a verbatim substring of originalText",
        });
      }
    });
  });
export type NormalizedRequirement = z.infer<typeof NormalizedRequirementSchema>;
