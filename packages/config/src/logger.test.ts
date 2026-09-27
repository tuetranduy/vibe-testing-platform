import { createRunRedactor } from "@platform/security";
import { describe, expect, it } from "vitest";
import { createLogger, createRunLogRegistry } from "./logger";

const SECRET = "pw-Logger-Secret-77";
const at = new Date("2026-09-26T10:00:00.000Z");

function capture(opts: Partial<Parameters<typeof createLogger>[0]> = {}) {
  const lines: string[] = [];
  const logger = createLogger({ component: "worker", now: () => at, write: (l) => void lines.push(l), ...opts });
  const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { logger, lines, parsed };
}

describe("createLogger", () => {
  it("writes one JSON line per call with level, time, component and msg; below-level lines are dropped", () => {
    const { logger, parsed } = capture({ level: "info" });
    logger.debug({ a: 1 }, "hidden");
    logger.info({ a: 1 }, "shown");
    expect(parsed()).toEqual([{ level: "info", time: at.toISOString(), component: "worker", a: 1, msg: "shown" }]);
  });

  it("redacts by key on every line, run or not", () => {
    const { logger, lines } = capture();
    logger.info({ password: "p", headers: { authorization: "Bearer x" }, inputTokens: 12 });
    expect(JSON.parse(lines[0]!)).toMatchObject({ password: "[REDACTED]", headers: { authorization: "[REDACTED]" }, inputTokens: 12 });
  });

  it("a registered run's lines carry tenantId and the current stage, and its secret values are redacted everywhere (fields, err, msg)", () => {
    const runs = createRunLogRegistry();
    const { logger, lines, parsed } = capture({ runs });
    const release = runs.register("run_1", { tenantId: "t_1", stage: "EXPLORING", redact: createRunRedactor([SECRET]) });

    logger.error({ runId: "run_1", detail: `typed ${SECRET}`, err: new Error(`launch failed: ${SECRET}`) }, `saw ${SECRET}`);
    runs.setStage("run_1", "VERIFYING");
    logger.info({ runId: "run_1" }, "next");
    release();
    logger.info({ runId: "run_1" }, "after release");

    expect(lines.join("\n")).not.toContain(SECRET);
    const [first, second, third] = parsed();
    expect(first).toEqual({
      level: "error",
      time: at.toISOString(),
      component: "worker",
      runId: "run_1",
      tenantId: "t_1",
      stage: "EXPLORING",
      detail: "typed [REDACTED]",
      err: { name: "Error", message: "launch failed: [REDACTED]", stack: expect.stringContaining("Error: launch failed: [REDACTED]\n    at ") },
      msg: "saw [REDACTED]",
    });
    expect(second).toMatchObject({ runId: "run_1", tenantId: "t_1", stage: "VERIFYING" });
    expect(third).not.toHaveProperty("tenantId");
    expect(runs.size).toBe(0);
  });

  it("fields a caller passes win over the run scope", () => {
    const runs = createRunLogRegistry();
    runs.register("run_1", { tenantId: "t_1", stage: "EXPLORING", redact: (v) => v });
    const { logger, parsed } = capture({ runs });
    logger.info({ runId: "run_1", stage: "ERRORED" });
    expect(parsed()[0]).toMatchObject({ stage: "ERRORED", tenantId: "t_1" });
  });

  it("child() adds bindings; a child's component overrides the parent's", () => {
    const { logger, parsed } = capture();
    logger.child({ component: "sandbox", runId: "run_9" }).warn({ x: 1 }, "m");
    expect(parsed()[0]).toMatchObject({ component: "sandbox", runId: "run_9", x: 1, msg: "m" });
  });

  it("never throws on values JSON cannot encode (cycles, BigInt); the line is still written", () => {
    const { logger, parsed } = capture();
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => logger.info({ cyclic, big: 10n }, "odd")).not.toThrow();
    expect(parsed()[0]).toMatchObject({ cyclic: { name: "loop", self: "[Circular]" }, big: "10", msg: "odd" });
  });

  it("writes a value referenced twice both times: only a value inside itself is [Circular]", () => {
    const { logger, parsed } = capture();
    const shared = { id: 7 };
    const list = [shared, shared];
    logger.info({ a: shared, b: shared, list, again: list });
    expect(parsed()[0]).toMatchObject({ a: { id: 7 }, b: { id: 7 }, list: [{ id: 7 }, { id: 7 }], again: [{ id: 7 }, { id: 7 }] });
  });

  it("err keeps its code, stack and cause chain, redacted like the rest of the line", () => {
    const runs = createRunLogRegistry();
    runs.register("run_1", { tenantId: "t_1", stage: "EXPLORING", redact: createRunRedactor([SECRET]) });
    const { logger, lines, parsed } = capture({ runs });
    const refused = Object.assign(new Error(`connect ECONNREFUSED for ${SECRET}`), { code: "ECONNREFUSED" });
    const err = new TypeError("fetch failed", { cause: refused });

    logger.error({ runId: "run_1", err }, "upload failed");

    expect(lines.join("\n")).not.toContain(SECRET);
    expect(parsed()[0]!.err).toEqual({
      name: "TypeError",
      message: "fetch failed",
      stack: expect.stringContaining("TypeError: fetch failed\n    at "),
      cause: {
        name: "Error",
        message: "connect ECONNREFUSED for [REDACTED]",
        code: "ECONNREFUSED",
        stack: expect.stringContaining("Error: connect ECONNREFUSED for [REDACTED]\n    at "),
      },
    });
  });

  it("a cause chain that loops ends in [Circular]; a cause that is not an Error is kept as a value", () => {
    const { logger, parsed } = capture();
    const a = new Error("a");
    (a as { cause?: unknown }).cause = new Error("b", { cause: a });
    logger.error({ err: a });
    logger.error({ err: new Error("c", { cause: { status: 503, password: "p" } }) });
    const [loop, plain] = parsed();
    expect(loop!.err).toMatchObject({ message: "a", cause: { message: "b", cause: "[Circular]" } });
    expect(plain!.err).toMatchObject({ message: "c", cause: { status: 503, password: "[REDACTED]" } });
  });

  it("keeps at most five causes below err", () => {
    const { logger, parsed } = capture();
    let err = new Error("e9");
    for (let i = 8; i >= 0; i--) err = new Error(`e${i}`, { cause: err });
    logger.error({ err });
    const messages: unknown[] = [];
    for (let e = parsed()[0]!.err as { message?: string; cause?: unknown } | string; ; e = (e as { cause: typeof e }).cause) {
      if (typeof e === "string") {
        messages.push(e);
        break;
      }
      messages.push(e.message);
    }
    expect(messages).toEqual(["e0", "e1", "e2", "e3", "e4", "e5", "[Truncated]"]);
  });

  it("a registration released twice, or replaced, does not remove the newer scope", () => {
    const runs = createRunLogRegistry();
    const releaseOld = runs.register("run_1", { tenantId: "t_1", stage: "PLANNING", redact: (v) => v });
    runs.register("run_1", { tenantId: "t_1", stage: "EXPLORING", redact: (v) => v });
    releaseOld();
    expect(runs.get("run_1")?.stage).toBe("EXPLORING");
  });
});
