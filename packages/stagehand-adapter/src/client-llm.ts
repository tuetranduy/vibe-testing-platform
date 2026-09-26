import type { ClientLLM } from "@browserbasehq/stagehand";
import type { JsonSchema, LlmClient, LlmContentPart, LlmMessage } from "@platform/llm";

/**
 * Stagehand `ClientLLM` bridge (Ruling R5, spike Q8): Stagehand's in-browser runtime calls back
 * into this process (`llm.generate`) and every call goes through `@platform/llm` — redaction,
 * retries, deadline, abort and LlmCall records with `stage: "EXPLORING"`. The provider
 * `ModelConfig` path (inference inside the browser) is never used.
 *
 * Calls are serialized (spike caveat 8: requests carry no correlation id), so the explorer can
 * attribute all usage between two `takeUsage()` calls to the one Stagehand operation it ran.
 */

type GenerateRequest = Parameters<ClientLLM["generate"]>[0];
type GenerateResult = Awaited<ReturnType<ClientLLM["generate"]>>;
type RequestPart = Extract<GenerateRequest["messages"][number]["content"], { type: string }>;

/** The part of LlmClient the bridge needs. */
export type StructuredLlm = Pick<LlmClient, "model" | "generateJson">;

export interface ClientLlmBridgeOptions {
  llm: StructuredLlm;
  runId: string;
  signal: AbortSignal;
  /** The run redactor (by key and by value). */
  redact: (value: unknown) => unknown;
  deadlineAt?: Date | null;
  maxTokens?: number;
}

export interface BridgeUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ClientLlmBridge {
  /** Pass as `Stagehand.create({ model })`. */
  readonly client: ClientLLM;
  readonly model: string;
  /** Usage since the previous call (and resets it). */
  takeUsage(): BridgeUsage;
  /** The first error a generate call raised since the previous call (and resets it). */
  takeError(): unknown;
}

/** Stagehand's text-mode calls are answered through the structured path with this envelope. */
const TEXT_ENVELOPE_SCHEMA: JsonSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

function toParts(content: GenerateRequest["messages"][number]["content"]): LlmContentPart[] {
  const parts = (Array.isArray(content) ? content : [content]) as RequestPart[];
  return parts.map((p): LlmContentPart => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "image") return { type: "image", data: p.data, mimeType: p.mimeType };
    throw new Error(`Stagehand requested an unsupported message part: ${p.type}`);
  });
}

function toMessages(req: GenerateRequest): LlmMessage[] {
  return req.messages.map((m) => ({ role: m.role, content: toParts(m.content) }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function createClientLlmBridge(opts: ClientLlmBridgeOptions): ClientLlmBridge {
  let usage: BridgeUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  let firstError: unknown;
  let chain: Promise<unknown> = Promise.resolve();

  const call = async (req: GenerateRequest): Promise<GenerateResult> => {
    const rf = "responseFormat" in req ? req.responseFormat : undefined;
    const json = rf?.type === "json_schema" ? rf : undefined;
    if (!json && "tools" in req && Array.isArray(req.tools) && req.tools.length > 0) {
      throw new Error("Stagehand requested tool use, which the ClientLLM bridge does not support");
    }
    const result = await opts.llm.generateJson({
      system: req.systemPrompt ?? "",
      messages: toMessages(req),
      jsonSchema: json ? (json.schema as JsonSchema) : TEXT_ENVELOPE_SCHEMA,
      schemaName: json ? json.name : "Text",
      stage: "EXPLORING",
      runId: opts.runId,
      signal: opts.signal,
      redact: opts.redact,
      deadlineAt: opts.deadlineAt ?? null,
      maxTokens: opts.maxTokens,
    });
    usage = {
      calls: usage.calls + 1,
      inputTokens: usage.inputTokens + result.usage.inputTokens,
      outputTokens: usage.outputTokens + result.usage.outputTokens,
    };
    const tokens = {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.inputTokens + result.usage.outputTokens,
    };
    if (json) {
      if (!isRecord(result.data)) throw new Error(`Model output for "${json.name}" is not a JSON object`);
      return {
        role: "assistant",
        content: { type: "text", text: JSON.stringify(result.data) },
        stopReason: "stop",
        usage: tokens,
        outputFormat: "json_schema",
        structuredContent: result.data,
      } as GenerateResult;
    }
    const text = isRecord(result.data) && typeof result.data.text === "string" ? result.data.text : "";
    return { role: "assistant", content: { type: "text", text }, stopReason: "stop", usage: tokens, outputFormat: "text" } as GenerateResult;
  };

  const client: ClientLLM = {
    generate: (req: GenerateRequest) => {
      const run = chain.then(() => call(req));
      chain = run.catch(() => {});
      return run.catch((err: unknown) => {
        firstError ??= err;
        throw err;
      });
    },
  };

  return {
    client,
    model: opts.llm.model,
    takeUsage() {
      const u = usage;
      usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
      return u;
    },
    takeError() {
      const e = firstError;
      firstError = undefined;
      return e;
    },
  };
}
