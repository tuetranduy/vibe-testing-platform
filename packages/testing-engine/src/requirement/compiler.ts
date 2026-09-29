import { ContractError, type TestDataValue } from "@platform/contracts";
import type { LlmClient } from "@platform/llm";
import { requireLlm, type RequirementDraft, type StageContext } from "../orchestrator/stages";
import { CompilerOutputSchema } from "./model-output";
import { postValidate } from "./post-validate";
import { REQUIREMENT_SYSTEM_PROMPT, buildRequirementPrompt } from "./prompts";

/** The slice of LlmClient the compiler needs (lets tests and later stages substitute it). */
export type RequirementLlm = Pick<LlmClient, "generateStructured">;

export interface CompileRequirementInput {
  runId: string;
  originalText: string;
  /** Only the keys reach the prompt; values are used for the deterministic threshold check. */
  testData: Record<string, TestDataValue>;
  secretNames: string[];
  signal: AbortSignal;
  deadlineAt?: Date | null;
  /** The run redactor (masks secret values). */
  redact: (value: unknown) => unknown;
}

/**
 * Natural-language requirement → structured criteria (the future revision 1). At most one correction
 * round covers both schema and post-validation failures; after that the compile fails with
 * ContractError. The orchestrator persists the draft and publishes the events.
 */
export async function compileRequirement(llm: RequirementLlm, input: CompileRequirementInput): Promise<RequirementDraft> {
  // A blank requirement is surveyed, never compiled: analysis only runs on a chosen text.
  if (input.originalText.trim() === "") throw new ContractError("The requirement is empty: there is nothing to compile");
  const source = { originalText: input.originalText, testData: input.testData };
  const { data } = await llm.generateStructured({
    schema: CompilerOutputSchema,
    schemaName: "requirement_criteria",
    system: REQUIREMENT_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildRequirementPrompt({
          originalText: input.originalText,
          testDataKeys: Object.keys(input.testData),
          secretNames: input.secretNames,
        }),
      },
    ],
    check: (output) => {
      const result = postValidate(output, source);
      return result.ok ? [] : result.issues;
    },
    stage: "ANALYZING_REQUIREMENT",
    runId: input.runId,
    signal: input.signal,
    deadlineAt: input.deadlineAt ?? null,
    redact: input.redact,
  });
  const result = postValidate(data, source);
  // Unreachable in practice (`check` already passed), but never hand an invalid draft on.
  if (!result.ok) throw new ContractError(`Compiled requirement is invalid: ${result.issues.join("; ")}`);
  return result.draft;
}

/** The real `analyze` stage: compiles the run's requirement with the run's model client, redactor and deadline. */
export function createAnalyzeStage(): (ctx: StageContext) => Promise<RequirementDraft> {
  return async (ctx) =>
    compileRequirement(requireLlm(ctx), {
      runId: ctx.runId,
      originalText: ctx.request.requirement,
      testData: ctx.request.testData,
      secretNames: ctx.secrets.names,
      signal: ctx.signal,
      deadlineAt: ctx.deadlineAt,
      redact: ctx.redact,
    });
}
