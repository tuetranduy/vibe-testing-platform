import type { ClientLLM } from "@browserbasehq/stagehand";
import { ContractError } from "@platform/contracts";
import type { JsonSchema, LlmClient, LlmContentPart, LlmMessage } from "@platform/llm";

/**
 * Stagehand `ClientLLM` bridge (Ruling R5, spike Q8): Stagehand's in-browser runtime calls back
 * into this process (`llm.generate`) and every call goes through `@platform/llm` — redaction,
 * retries, deadline, abort and LlmCall records with `stage: "EXPLORING"`. The provider
 * `ModelConfig` path (inference inside the browser) is never used.
 *
 * Calls are serialized (spike caveat 8: requests carry no correlation id), so the explorer can
 * attribute all usage between two `takeUsage()` calls to the one Stagehand operation it ran. The
 * explorer runs each Stagehand operation through `operation()`: Stagehand's timeout never cancels a
 * model call in flight, so the bridge does when the operation ends (KI-020).
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
  /**
   * Runs one Stagehand operation. A model call it leaves running (Stagehand gave up on it) is
   * aborted when it ends, so the next operation's call starts at once, and a call made after it
   * ended (the abandoned operation carrying on) is refused. Neither one's error is reported.
   */
  operation<T>(fn: () => Promise<T>): Promise<T>;
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
    throw new ContractError(`Stagehand requested an unsupported message part: ${p.type}`);
  });
}

function toMessages(req: GenerateRequest): LlmMessage[] {
  return req.messages.map((m) => ({ role: m.role, content: toParts(m.content) }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const objectCheck = (v: unknown): string[] => (isRecord(v) ? [] : ["(root): the response must be a JSON object"]);
const textEnvelopeCheck = (v: unknown): string[] =>
  isRecord(v) && typeof v.text === "string" ? [] : ['(root): the response must be {"text": string}'];

export function createClientLlmBridge(opts: ClientLlmBridgeOptions): ClientLlmBridge {
  let usage: BridgeUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  let firstError: unknown;
  let chain: Promise<unknown> = Promise.resolve();
  /** The running operation's calls end with it: undefined before the first operation, null between two. */
  let current: AbortController | null | undefined;

  const call = async (req: GenerateRequest, signal: AbortSignal): Promise<GenerateResult> => {
    const rf = "responseFormat" in req ? req.responseFormat : undefined;
    const json = rf?.type === "json_schema" ? rf : undefined;
    if (!json && "tools" in req && Array.isArray(req.tools) && req.tools.length > 0) {
      throw new ContractError("Stagehand requested tool use, which the ClientLLM bridge does not support");
    }
    const result = await opts.llm.generateJson({
      system: req.systemPrompt ?? "",
      messages: toMessages(req),
      jsonSchema: json ? (json.schema as JsonSchema) : TEXT_ENVELOPE_SCHEMA,
      schemaName: json ? json.name : "Text",
      // Stagehand's structuredContent must be an object: a non-object gets the correction round
      // and then fails as ContractError with INVALID_OUTPUT records.
      check: json ? objectCheck : textEnvelopeCheck,
      stage: "EXPLORING",
      runId: opts.runId,
      signal,
      redact: opts.redact,
      deadlineAt: opts.deadlineAt ?? null,
      maxTokens: opts.maxTokens,
      // Browser steps run at the run's reasoning level (the client's), like every other stage: at a thinking
      // model's default level each observe took 10–27 s and exploration overran its time (KI-001).
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
    if (json && isRecord(result.data)) {
      return {
        role: "assistant",
        content: { type: "text", text: JSON.stringify(result.data) },
        stopReason: "stop",
        usage: tokens,
        outputFormat: "json_schema",
        structuredContent: result.data,
      } as GenerateResult;
    }
    if (json) throw new ContractError(`Model output for "${json.name}" is not a JSON object`); // unreachable: checked above
    const text = isRecord(result.data) && typeof result.data.text === "string" ? result.data.text : "";
    return { role: "assistant", content: { type: "text", text }, stopReason: "stop", usage: tokens, outputFormat: "text" } as GenerateResult;
  };

  const client: ClientLLM = {
    generate: (req: GenerateRequest) => {
      if (current === null) return Promise.reject(new Error("The Stagehand operation that made this model call has ended"));
      const operation = current?.signal;
      const run = chain.then(() => call(req, operation ? AbortSignal.any([opts.signal, operation]) : opts.signal));
      chain = run.catch(() => {});
      return run.catch((err: unknown) => {
        // A call cancelled because its operation ended fails for no reason of its own.
        if (!operation?.aborted) firstError ??= err;
        throw err;
      });
    },
  };

  return {
    client,
    model: opts.llm.model,
    async operation<T>(fn: () => Promise<T>): Promise<T> {
      const controller = new AbortController();
      current = controller;
      try {
        return await fn();
      } finally {
        controller.abort(new Error("The Stagehand operation ended"));
        current = null;
      }
    },
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
