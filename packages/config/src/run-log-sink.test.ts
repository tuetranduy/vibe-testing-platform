import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunLogSink, type SinkLine } from "./run-log-sink";

const rec = (over: Record<string, unknown> = {}) => ({
  level: "info",
  time: "2026-11-25T10:00:00.000Z",
  component: "worker",
  runId: "run_1",
  stage: "EXPLORING",
  msg: "step",
  ...over,
});

function setup(opts: Partial<Parameters<typeof createRunLogSink>[0]> = {}) {
  const written: SinkLine[][] = [];
  const drops: Record<string, number> = {};
  const sink = createRunLogSink({
    component: "worker",
    write: async (lines) => void written.push(lines),
    onDrop: (reason, n) => void (drops[reason] = (drops[reason] ?? 0) + n),
    ...opts,
  });
  const all = () => written.flat();
  return { sink, written, drops, all };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createRunLogSink", () => {
  it("flushes every 500 ms", async () => {
    const { sink, written } = setup();
    sink.accept(rec());
    expect(written).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(499);
    expect(written).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(written).toHaveLength(1);
    await sink.close();
  });

  it("flushes at 200 lines without waiting", async () => {
    const { sink, written } = setup();
    for (let i = 0; i < 200; i++) sink.accept(rec());
    await vi.advanceTimersByTimeAsync(0);
    expect(written.map((b) => b.length)).toEqual([200]);
    await sink.close();
  });

  it("ignores records without a runId", async () => {
    const { sink, all } = setup();
    sink.accept(rec({ runId: undefined }));
    await sink.flush();
    expect(all()).toEqual([]);
    await sink.close();
  });

  it("maps a record to a line", async () => {
    const { sink, all } = setup();
    sink.accept(rec({ tenantId: "t_1", step: 4, err: { message: "x" } }));
    await sink.flush();
    expect(all()).toEqual([
      {
        runId: "run_1",
        time: new Date("2026-11-25T10:00:00.000Z"),
        source: "worker",
        level: "info",
        stage: "EXPLORING",
        component: "worker",
        message: "step",
        fields: { step: 4, err: { message: "x" } },
      },
    ]);
    await sink.close();
  });

  it("classifies the source", async () => {
    const { sink, all } = setup();
    sink.accept(rec({ source: "infra" }));
    sink.accept(rec({ source: "nonsense" }));
    sink.accept(rec({ component: "api" }));
    sink.accept(rec({ component: "runner" }));
    sink.accept(rec({ component: "egress-proxy" }));
    sink.accept(rec({ stage: "NOT_A_STAGE" }));
    await sink.flush();
    expect(all().map((l) => l.source)).toEqual(["infra", "worker", "api", "runner", "worker", "worker"]);
    expect(all().at(-1)!.stage).toBeNull();
    expect(all()[1]!.fields).not.toHaveProperty("source");
    await sink.close();
  });

  it("cuts long field strings", async () => {
    const { sink, all } = setup();
    sink.accept(rec({ err: { stack: "s".repeat(20_000) }, msg: "m".repeat(17_000) }));
    await sink.flush();
    const line = all()[0]!;
    const stack = (line.fields.err as { stack: string }).stack;
    expect(stack).toBe(`${"s".repeat(16_384)}…[truncated 3616 chars]`);
    expect(line.message).toBe(`${"m".repeat(16_384)}…[truncated 616 chars]`);
    await sink.close();
  });

  it("after the cap keeps warn and above", async () => {
    const { sink, all, drops } = setup({ maxLinesPerRun: 3 });
    for (let i = 0; i < 5; i++) sink.accept(rec({ msg: `i${i}` }));
    sink.accept(rec({ level: "error", msg: "boom" }));
    await sink.flush();
    expect(all().map((l) => [l.source, l.level, l.message])).toEqual([
      ["worker", "info", "i0"],
      ["worker", "info", "i1"],
      ["worker", "info", "i2"],
      ["infra", "warn", "run log line cap reached"],
      ["worker", "error", "boom"],
    ]);
    expect(drops.cap).toBe(2);
    await sink.close();
  });

  it("a full buffer drops oldest low-level lines first", async () => {
    const { sink, all, drops } = setup({ bufferLimit: 3, batchSize: 1000 });
    sink.accept(rec({ level: "error", msg: "e0" }));
    sink.accept(rec({ msg: "i1" }));
    sink.accept(rec({ msg: "i2" }));
    sink.accept(rec({ level: "warn", msg: "w3" }));
    sink.accept(rec({ level: "error", msg: "e4" }));
    sink.accept(rec({ level: "error", msg: "e5" }));
    await sink.flush();
    expect(all().map((l) => l.message)).toEqual(["w3", "e4", "e5"]);
    expect(drops.buffer_full).toBe(3);
    await sink.close();
  });

  it("insert failure never rejects and is counted", async () => {
    const errors: unknown[] = [];
    const { sink, drops } = setup({
      write: async () => {
        throw new Error("db down");
      },
      onWriteError: (err) => void errors.push(err),
    });
    sink.accept(rec());
    sink.accept(rec());
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(drops.insert_failed).toBe(2);
    expect(errors).toHaveLength(1);
    await expect(sink.close()).resolves.toBeUndefined();
  });

  it("close flushes what is left and stops the timer", async () => {
    const { sink, written } = setup();
    sink.accept(rec());
    await sink.close();
    expect(written).toHaveLength(1);
    sink.accept(rec());
    await vi.advanceTimersByTimeAsync(2000);
    expect(written).toHaveLength(1);
  });
});

describe("createRunLogSink with lines a database might refuse", () => {
  it("never cuts a long string through an emoji", async () => {
    const { sink, all } = setup();
    sink.accept(rec({ html: `${"a".repeat(16_383)}😀${"b".repeat(100)}` }));
    await sink.flush();
    const html = all()[0]!.fields.html as string;
    expect(html.startsWith("a".repeat(16_383))).toBe(true);
    expect(html.charCodeAt(16_383)).not.toBe(0xd83d);
    expect(html).toMatch(/…\[truncated \d+ chars\]$/);
    await sink.close();
  });

  it("keeps a line with a circular field", async () => {
    const { sink, all } = setup();
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    sink.accept(rec({ loop }));
    await sink.flush();
    expect(all()[0]!.fields).toEqual({ loop: { a: 1, self: "[Circular]" } });
    await sink.close();
  });

  it("a refused batch is retried line by line, so one bad line costs one line", async () => {
    const written: SinkLine[] = [];
    const drops: Record<string, number> = {};
    const sink = createRunLogSink({
      component: "worker",
      write: async (lines) => {
        if (lines.some((l) => l.message === "bad")) throw new Error("invalid input syntax for type json");
        written.push(...lines);
      },
      onDrop: (reason, n) => void (drops[reason] = (drops[reason] ?? 0) + n),
    });
    sink.accept(rec({ msg: "one" }));
    sink.accept(rec({ msg: "bad" }));
    sink.accept(rec({ msg: "two" }));
    await sink.flush();
    expect(written.map((l) => l.message)).toEqual(["one", "two"]);
    expect(drops.insert_failed).toBe(1);
    await sink.close();
  });
});

describe("createRunLogSink when the database is down", () => {
  it("gives up retrying after three refused lines in a row", async () => {
    let writes = 0;
    const drops: Record<string, number> = {};
    const sink = createRunLogSink({
      component: "worker",
      batchSize: 1000,
      write: async () => {
        writes += 1;
        throw new Error("connect ECONNREFUSED");
      },
      onDrop: (reason, n) => void (drops[reason] = (drops[reason] ?? 0) + n),
    });
    for (let i = 0; i < 10; i++) sink.accept(rec({ msg: `m${i}` }));
    await sink.flush();
    expect(writes).toBe(4);
    expect(drops.insert_failed).toBe(10);
    await sink.close();
  });
});
