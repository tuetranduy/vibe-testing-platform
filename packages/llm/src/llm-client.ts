import {
  CancelledError,
  ContractError,
  EngineError,
  ModelProviderError,
  type ReasoningLevel,
  type RunLifecycle,
} from "@platform/contracts";
import { z, type ZodType } from "zod";
import { estimateCostUsd, priceFor } from "./pricing";
import { DEFAULT_RETRY, backoffMs, sleep as defaultSleep, type RetryPolicy } from "./retry";
import { LlmTransportError, type LlmTransport, type LlmTransportResponse } from "./transport";
import type { JsonSchema, LlmCallRecord, LlmCallSink, LlmCallStatus, LlmMessage, LlmUsage } from "./types";

export interface LlmClientOptions {
  transport: LlmTransport;
  model: string;
  /** The run's reasoning level (default "default": no reasoning parameter). A call's `reasoning` overrides it. */
  reasoning?: ReasoningLevel;
  recordCall?: LlmCallSink;
  /** Called when `recordCall` throws; the model call itself still succeeds. */
  onRecordError?: (err: unknown, call: LlmCallRecord) => void;
  /** Receives operational warnings (e.g. a model with no known price). Defaults to console.warn. */
  logger?: { warn(obj: object, msg?: string): void };
  maxTokens?: number;
  retry?: Partial<RetryPolicy>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** What every structured call needs: the prompt plus the run's attribution, abort signal and redactor. */
export interface LlmCallInput {
  system: string;
  messages: LlmMessage[];
  stage: RunLifecycle;
  runId: string;
  signal: AbortSignal;
  /** The run redactor. Applied to system + messages before every request. */
  redact: (value: unknown) => unknown;
  /** Backoff never sleeps past this instant; the call gives up instead. */
  deadlineAt?: Date | null;
  maxTokens?: number;
  /** Identifies the call to the provider (e.g. Stagehand's "Act", "Observation"). */
  schemaName?: string;
  /** This call's reasoning level instead of the client's (the Stagehand bridge always sends "default"). */
  reasoning?: ReasoningLevel;
}

/** What a caller's `check` is told about the answer it judges. */
export interface CheckContext {
  /** True for the answer to the correction round: the last one the client asks for. */
  corrected: boolean;
}

export interface GenerateStructuredInput<T> extends LlmCallInput {
  schema: ZodType<T>;
  /**
   * Extra deterministic validation of the parsed value. Returned issues trigger the same single
   * correction round as schema failures; `context.corrected` says whether this is the corrected
   * answer (a caller may accept a partly valid last answer and keep what is valid).
   */
  check?: (data: T, context: CheckContext) => string[];
}

export interface GenerateJsonInput extends LlmCallInput {
  jsonSchema: JsonSchema;
  /**
   * Deterministic validation of the parsed JSON (the provider constrains the shape, this checks what
   * the caller relies on). Returned issues trigger the same single correction round as schema failures.
   */
  check?: (data: unknown, context: CheckContext) => string[];
}

export interface StructuredResult<T> {
  data: T;
  usage: LlmUsage;
}

type Validation<T> = { ok: true; data: T } | { ok: false; issues: string[] };

const DEFAULT_MAX_TOKENS = 16_000;
const MAX_ISSUES_IN_PROMPT = 20;

/**
 * Provider-neutral structured-output client. Owns redaction, retries (429/5xx, bounded by the run
 * deadline), cancellation, one correction round for invalid output, and per-request LlmCall records.
 */
export class LlmClient {
  private readonly retry: RetryPolicy;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Models already reported as unpriced (the requested one, and any fallback that served a call). */
  private readonly unpriced = new Set<string>();

  constructor(private readonly opts: LlmClientOptions) {
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.warnIfUnpriced(opts.model);
  }

  private warnIfUnpriced(model: string): void {
    if (priceFor(model) || this.unpriced.has(model)) return;
    this.unpriced.add(model);
    (this.opts.logger ?? consoleLogger).warn(
      { model, provider: this.opts.transport.provider },
      "LLM model has no price in @platform/llm pricing; estimatedCostUsd will be recorded as 0",
    );
  }

  get model(): string {
    return this.opts.model;
  }

  get provider(): string {
    return this.opts.transport.provider;
  }

  /** The level every call sends unless it names its own. */
  get reasoning(): ReasoningLevel {
    return this.opts.reasoning ?? "default";
  }

  /** Structured output validated with a Zod schema (plus optional `check`). */
  generateStructured<T>(input: GenerateStructuredInput<T>): Promise<StructuredResult<T>> {
    const jsonSchema = zodToJsonSchema(input.schema);
    return this.run(input, jsonSchema, (value, context) => {
      const parsed = input.schema.safeParse(value);
      if (!parsed.success) return { ok: false, issues: parsed.error.issues.map(formatIssue) };
      const issues = input.check?.(parsed.data, context) ?? [];
      return issues.length > 0 ? { ok: false, issues } : { ok: true, data: parsed.data };
    });
  }

  /**
   * Structured output against a raw JSON Schema (for callers that don't own a Zod schema, e.g. the
   * Stagehand ClientLLM bridge). The provider constrains the shape; the client only checks it's JSON.
   */
  generateJson(input: GenerateJsonInput): Promise<StructuredResult<unknown>> {
    return this.run(input, input.jsonSchema, (value, context) => {
      const issues = input.check?.(value, context) ?? [];
      return issues.length > 0 ? { ok: false, issues } : { ok: true, data: value };
    });
  }

  private async run<T>(
    input: LlmCallInput,
    jsonSchema: JsonSchema,
    validate: (value: unknown, context: CheckContext) => Validation<T>,
  ): Promise<StructuredResult<T>> {
    const usage: LlmUsage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
    let messages = input.messages;
    for (let round = 0; ; round++) {
      const { response, latencyMs, answeredAt } = await this.request(input, messages, jsonSchema);
      // Priced and recorded by the requested model (providers may echo a resolved snapshot id), or by the
      // model that served it after a refusal fallback, at the price in force when it answered.
      const servedBy = response.fallbackModel ?? this.opts.model;
      if (response.fallbackModel) this.warnIfUnpriced(response.fallbackModel);
      const cost = estimateCostUsd(servedBy, response.usage.inputTokens, response.usage.outputTokens, new Date(answeredAt)) ?? 0;
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      usage.estimatedCostUsd = round6(usage.estimatedCostUsd + cost);

      const result = parseAndValidate(response.text, (value) => validate(value, { corrected: round > 0 }));
      await this.record(input, {
        model: servedBy,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        estimatedCostUsd: cost,
        latencyMs,
        status: result.ok ? "SUCCESS" : "INVALID_OUTPUT",
      });
      if (result.ok) return { data: result.data, usage };
      if (round >= 1) {
        throw new ContractError(
          `Model output is invalid after one correction: ${result.issues.slice(0, 5).join("; ")}`,
        );
      }
      messages = [
        ...input.messages,
        { role: "assistant", content: response.text },
        { role: "user", content: correctionPrompt(result.issues) },
      ];
    }
  }

  /** One logical request: redaction, retries with backoff bounded by the deadline, abort. */
  private async request(
    input: LlmCallInput,
    messages: LlmMessage[],
    jsonSchema: JsonSchema,
  ): Promise<{ response: LlmTransportResponse; latencyMs: number; answeredAt: number }> {
    const { signal } = input;
    const redacted = input.redact({ system: input.system, messages }) as { system: string; messages: LlmMessage[] };
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw abortError(signal);
      const started = this.now();
      try {
        const response = await raceAbort(
          this.opts.transport.complete({
            model: this.opts.model,
            system: redacted.system,
            messages: redacted.messages,
            jsonSchema,
            schemaName: input.schemaName ?? "output",
            maxTokens: input.maxTokens ?? this.opts.maxTokens ?? DEFAULT_MAX_TOKENS,
            reasoning: input.reasoning ?? this.reasoning,
            signal,
          }),
          signal,
        );
        const answeredAt = this.now();
        return { response, latencyMs: answeredAt - started, answeredAt };
      } catch (err) {
        const latencyMs = this.now() - started;
        if (signal.aborted) {
          await this.record(input, failedCall(this.opts.model, latencyMs, "CANCELLED"));
          throw abortError(signal);
        }
        await this.record(input, failedCall(this.opts.model, latencyMs, "PROVIDER_ERROR"));
        const transportErr = err instanceof LlmTransportError ? err : null;
        if (!transportErr?.retryable || attempt >= this.retry.maxRetries) {
          throw new ModelProviderError(`Model provider request failed: ${messageOf(err)}`, { cause: err });
        }
        const delay = backoffMs(this.retry, attempt, transportErr.retryAfterMs);
        const deadline = input.deadlineAt?.getTime();
        if (deadline !== undefined && this.now() + delay >= deadline) {
          throw new ModelProviderError(`Model provider request failed and a retry would pass the run deadline: ${messageOf(err)}`, {
            cause: err,
          });
        }
        try {
          await this.sleep(delay, signal);
        } catch (sleepErr) {
          if (signal.aborted) throw abortError(signal);
          throw sleepErr;
        }
      }
    }
  }

  private async record(
    input: LlmCallInput,
    call: Omit<LlmCallRecord, "runId" | "stage" | "provider">,
  ): Promise<void> {
    if (!this.opts.recordCall) return;
    const record: LlmCallRecord = { runId: input.runId, stage: input.stage, provider: this.provider, ...call };
    try {
      await this.opts.recordCall(record);
    } catch (err) {
      this.opts.onRecordError?.(err, record);
    }
  }
}

function zodToJsonSchema(schema: ZodType): JsonSchema {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { unrepresentable: "any" }) as JsonSchema;
  return json;
}

function parseAndValidate<T>(text: string, validate: (value: unknown) => Validation<T>): Validation<T> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, issues: ["(root): the response is not valid JSON"] };
  }
  return validate(value);
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join(".");
  return `${path || "(root)"}: ${issue.message}`;
}

function correctionPrompt(issues: string[]): string {
  const shown = issues.slice(0, MAX_ISSUES_IN_PROMPT);
  const more = issues.length > shown.length ? `\n- …and ${issues.length - shown.length} more` : "";
  return (
    "Your previous response did not pass validation. Fix every issue below and return the complete corrected JSON only.\n" +
    shown.map((i) => `- ${i}`).join("\n") +
    more
  );
}

function failedCall(model: string, latencyMs: number, status: LlmCallStatus): Omit<LlmCallRecord, "runId" | "stage" | "provider"> {
  return { model, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs, status };
}

/** Keep typed abort reasons (CancelledError, DeadlineExceededError); anything else is a cancellation. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof EngineError || reason instanceof CancelledError) return reason;
  return new CancelledError();
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const consoleLogger = { warn: (obj: object, msg?: string) => console.warn(msg, obj) };

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
