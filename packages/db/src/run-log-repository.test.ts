import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunLogRepository, type NewRunLogLine } from "./run-log-repository";
import { RunRepository } from "./run-repository";
import { storedRequest } from "./test-helpers";
import { OTHER_TENANT_ID, TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "./testing";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => tdb?.drop());

const newRun = (tenantId = TEST_TENANT_ID) =>
  new RunRepository(tdb.db).create({ tenantId, targetUrl: "https://x.com", request: storedRequest() });

const line = (runId: string, over: Partial<NewRunLogLine> = {}): NewRunLogLine => ({
  runId,
  time: new Date("2026-11-25T10:00:00.000Z"),
  source: "worker",
  level: "info",
  stage: "EXPLORING",
  component: "worker",
  message: "step",
  fields: { step: 1 },
  ...over,
});

const at = (s: number) => new Date(Date.UTC(2026, 10, 25, 10, 0, s));

describe("RunLogRepository", () => {
  it("appendMany stores lines with the run's tenant", async () => {
    const run = await newRun();
    const repo = new RunLogRepository(tdb.db);
    expect(await repo.appendMany([line(run.id)])).toBe(1);
    const page = await repo.list(TEST_TENANT_ID, run.id, { limit: 500 });
    expect(page.lines).toHaveLength(1);
    expect(page.lines[0]).toMatchObject({
      source: "worker",
      level: "info",
      stage: "EXPLORING",
      component: "worker",
      message: "step",
      fields: { step: 1 },
      time: "2026-11-25T10:00:00.000Z",
    });
    expect(page.lines[0]!.id).toMatch(/^log_/);
  });

  it("appendMany skips lines of unknown runs", async () => {
    const run = await newRun();
    const repo = new RunLogRepository(tdb.db);
    expect(await repo.appendMany([line(run.id), line("run_missing")])).toBe(1);
    expect(await repo.count(run.id)).toBe(1);
    expect(await repo.appendMany([])).toBe(0);
  });

  it("list orders by time then id and pages by cursor", async () => {
    const run = await newRun();
    const repo = new RunLogRepository(tdb.db);
    await repo.appendMany([4, 0, 2, 1, 3].map((s) => line(run.id, { time: at(s), message: `m${s}` })));
    const messages: string[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await repo.list(TEST_TENANT_ID, run.id, { limit: 2, after });
      pages += 1;
      messages.push(...page.lines.map((l) => l.message));
      if (!page.nextCursor) break;
      after = page.nextCursor;
    }
    expect(messages).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(pages).toBe(3);
  });

  it("lines with the same time keep the order they were written in, across pages", async () => {
    const run = await newRun();
    const repo = new RunLogRepository(tdb.db);
    await repo.appendMany(Array.from({ length: 20 }, (_, i) => line(run.id, { time: at(0), message: `m${i}` })));
    const all = await repo.list(TEST_TENANT_ID, run.id, { limit: 500 });
    expect(all.lines.map((l) => l.message)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`));
    const first = await repo.list(TEST_TENANT_ID, run.id, { limit: 7 });
    const second = await repo.list(TEST_TENANT_ID, run.id, { limit: 7, after: first.nextCursor! });
    expect([...first.lines, ...second.lines].map((l) => l.message)).toEqual(Array.from({ length: 14 }, (_, i) => `m${i}`));
    const tail = await repo.list(TEST_TENANT_ID, run.id, { limit: 3, tail: "1" });
    expect(tail.lines.map((l) => l.message)).toEqual(["m17", "m18", "m19"]);
  });

  it("list filters by source, minLevel, stage and q", async () => {
    const run = await newRun();
    const repo = new RunLogRepository(tdb.db);
    await repo.appendMany([
      line(run.id, { time: at(0), source: "infra", level: "warn", message: "Egress blocked", stage: "EXPLORING" }),
      line(run.id, { time: at(1), source: "worker", level: "debug", message: "tick", stage: "EXPLORING" }),
      line(run.id, { time: at(2), source: "worker", level: "error", message: "run errored", stage: "GENERATING_REPORT" }),
      line(run.id, { time: at(3), source: "target_site", level: "error", message: "console", stage: null }),
    ]);
    const msgs = async (q: Parameters<RunLogRepository["list"]>[2]) =>
      (await repo.list(TEST_TENANT_ID, run.id, q)).lines.map((l) => l.message);
    expect(await msgs({ limit: 500, source: ["infra", "target_site"] })).toEqual(["Egress blocked", "console"]);
    expect(await msgs({ limit: 500, minLevel: "warn" })).toEqual(["Egress blocked", "run errored", "console"]);
    expect(await msgs({ limit: 500, stage: "GENERATING_REPORT" })).toEqual(["run errored"]);
    expect(await msgs({ limit: 500, q: "egress" })).toEqual(["Egress blocked"]);
    expect(await msgs({ limit: 500, q: "100%_" })).toEqual([]);
  });

  it("list never returns another tenant's run", async () => {
    const run = await newRun(OTHER_TENANT_ID);
    const repo = new RunLogRepository(tdb.db);
    await repo.appendMany([line(run.id)]);
    expect(await repo.list(TEST_TENANT_ID, run.id, { limit: 500 })).toEqual({ lines: [], nextCursor: null, pollSeq: null });
  });

  it("countWebAppLines counts one user's web_app lines", async () => {
    const run = await newRun();
    const repo = new RunLogRepository(tdb.db);
    await repo.appendMany([
      line(run.id, { source: "web_app", fields: { userId: "usr_a" } }),
      line(run.id, { source: "web_app", fields: { userId: "usr_a" } }),
      line(run.id, { source: "web_app", fields: { userId: "usr_b" } }),
      line(run.id, { source: "worker", fields: { userId: "usr_a" } }),
    ]);
    expect(await repo.countWebAppLines(run.id, "usr_a")).toBe(2);
  });

  it("deleteOlderThan deletes at most limit rows older than cutoff", async () => {
    const run = await newRun();
    const repo = new RunLogRepository(tdb.db);
    await repo.appendMany([
      line(run.id, { time: new Date("2000-01-01T00:00:00Z") }),
      line(run.id, { time: new Date("2000-01-02T00:00:00Z") }),
      line(run.id, { time: new Date("2000-01-03T00:00:00Z") }),
      line(run.id, { time: new Date("2100-01-01T00:00:00Z") }),
    ]);
    const cutoff = new Date("2001-01-01T00:00:00Z");
    expect(await repo.deleteOlderThan(cutoff, 2)).toBe(2);
    expect(await repo.deleteOlderThan(cutoff, 2)).toBe(1);
    expect(await repo.count(run.id)).toBe(1);
  });
});

describe("RunLogRepository live polling", () => {
  it("afterSeq returns lines stored later even when their time is earlier", async () => {
    const run = await newRun();
    const repo = new RunLogRepository(tdb.db);
    await repo.appendMany([line(run.id, { time: at(5), message: "worker line" })]);
    const first = await repo.list(TEST_TENANT_ID, run.id, { limit: 500 });
    expect(first.pollSeq).toBe(first.lines[0]!.seq);
    // Another process's line, written at 3 s but stored after the poll above.
    await repo.appendMany([line(run.id, { time: at(3), message: "api line" })]);
    const next = await repo.list(TEST_TENANT_ID, run.id, { limit: 500, afterSeq: first.pollSeq! });
    expect(next.lines.map((l) => l.message)).toEqual(["api line"]);
    const empty = await repo.list(TEST_TENANT_ID, run.id, { limit: 500, afterSeq: next.pollSeq! });
    expect(empty).toEqual({ lines: [], nextCursor: null, pollSeq: next.pollSeq });
  });

  it("pollSeq is the run's latest line even when a filter hides it", async () => {
    const run = await newRun();
    const repo = new RunLogRepository(tdb.db);
    await repo.appendMany([line(run.id, { time: at(0), level: "error" }), line(run.id, { time: at(1), level: "info" })]);
    const all = await repo.list(TEST_TENANT_ID, run.id, { limit: 500 });
    const errors = await repo.list(TEST_TENANT_ID, run.id, { limit: 500, minLevel: "error" });
    expect(errors.pollSeq).toBe(all.pollSeq);
  });

  it("tail returns the last lines in time order", async () => {
    const run = await newRun();
    const repo = new RunLogRepository(tdb.db);
    await repo.appendMany([0, 1, 2, 3, 4].map((s) => line(run.id, { time: at(s), level: s % 2 ? "error" : "info", message: `m${s}` })));
    const tail = await repo.list(TEST_TENANT_ID, run.id, { limit: 2, tail: "1" });
    expect(tail.lines.map((l) => l.message)).toEqual(["m3", "m4"]);
    expect(tail.nextCursor).toBeNull();
    const errors = await repo.list(TEST_TENANT_ID, run.id, { limit: 5, tail: "1", minLevel: "error" });
    expect(errors.lines.map((l) => l.message)).toEqual(["m1", "m3"]);
  });
});

describe("RunLogRepository stores what Postgres would reject", () => {
  it("a lone surrogate, a NUL and a bigint are made storable; the other lines in the batch are kept", async () => {
    const run = await newRun();
    const repo = new RunLogRepository(tdb.db);
    const half = "😀".slice(0, 1);
    const stored = await repo.appendMany([
      line(run.id, { time: at(0), message: "good" }),
      line(run.id, { time: at(1), message: `nul\u0000here ${half}`, fields: { text: `a\u0000b`, cut: `x${half}`, big: 10n as unknown, nested: { s: half } } }),
      line(run.id, { time: at(2), message: "also good" }),
    ]);
    expect(stored).toBe(3);
    const lines = (await repo.list(TEST_TENANT_ID, run.id, { limit: 10 })).lines;
    expect(lines.map((l) => l.message)).toEqual(["good", "nulhere \uFFFD", "also good"]);
    expect(lines[1]!.fields).toEqual({ text: "ab", cut: "x\uFFFD", big: "10", nested: { s: "\uFFFD" } });
  });

  it("a circular field is stored as [Circular]", async () => {
    const run = await newRun();
    const repo = new RunLogRepository(tdb.db);
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    expect(await repo.appendMany([line(run.id, { fields: { loop } })])).toBe(1);
    const [stored] = (await repo.list(TEST_TENANT_ID, run.id, { limit: 10 })).lines;
    expect(stored!.fields).toEqual({ loop: { a: 1, self: "[Circular]" } });
  });

  it("a Date field is stored as its ISO string", async () => {
    const run = await newRun();
    const repo = new RunLogRepository(tdb.db);
    await repo.appendMany([line(run.id, { fields: { at: new Date("2026-11-25T10:00:00.000Z") } })]);
    const [stored] = (await repo.list(TEST_TENANT_ID, run.id, { limit: 10 })).lines;
    expect(stored!.fields).toEqual({ at: "2026-11-25T10:00:00.000Z" });
  });
});
