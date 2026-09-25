import { LlmTransportError, type LlmTransport, type LlmTransportRequest, type LlmTransportResponse } from "../transport";

type Usage = { inputTokens: number; outputTokens: number };

/** A scripted reply: a JSON value, raw text, an error to throw, or "hang" until the request is aborted. */
export type FakeReply =
  | { json: unknown; usage?: Usage; model?: string }
  | { text: string; usage?: Usage; model?: string }
  | { error: Error }
  | "hang";

const DEFAULT_USAGE: Usage = { inputTokens: 10, outputTokens: 5 };

/**
 * Test transport: replays scripted replies in order and records every request it receives
 * (after redaction — exactly what a real provider would have been sent).
 */
export class FakeTransport implements LlmTransport {
  readonly provider = "fake";
  readonly requests: LlmTransportRequest[] = [];
  private readonly queue: (FakeReply | ((req: LlmTransportRequest) => FakeReply))[] = [];

  enqueue(...replies: (FakeReply | ((req: LlmTransportRequest) => FakeReply))[]): this {
    this.queue.push(...replies);
    return this;
  }

  async complete(request: LlmTransportRequest): Promise<LlmTransportResponse> {
    this.requests.push(request);
    const next = this.queue.shift();
    if (!next) throw new LlmTransportError("FakeTransport: no scripted reply", { retryable: false });
    const reply = typeof next === "function" ? next(request) : next;
    if (reply === "hang") {
      return new Promise((_, reject) => {
        const fail = () => reject(new LlmTransportError("aborted", { retryable: false }));
        if (request.signal.aborted) fail();
        request.signal.addEventListener("abort", fail, { once: true });
      });
    }
    if ("error" in reply) throw reply.error;
    const text = "json" in reply ? JSON.stringify(reply.json) : reply.text;
    return { text, model: reply.model ?? request.model, usage: reply.usage ?? DEFAULT_USAGE };
  }
}
