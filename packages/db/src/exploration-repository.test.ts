import type { ExplorationStep, ObservedFact } from "@platform/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExplorationStepRepository, ObservedFactRepository } from "./exploration-repository";
import { RunRepository } from "./run-repository";
import { explorationSteps } from "./schema";
import { storedRequest } from "./test-helpers";
import { TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "./testing";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => tdb?.drop());

const newRun = () => new RunRepository(tdb.db).create({ tenantId: TEST_TENANT_ID, targetUrl: "https://shop.example.com", request: storedRequest() });

const element = { candidates: [{ strategy: "role" as const, role: "button", name: "Add to cart", exact: true }], chosenIndex: 0, framePath: [] };
const stepOf = (runId: string, index: number, over: Partial<ExplorationStep> = {}): ExplorationStep => ({
  id: `step_${runId}_${index}`,
  runId,
  index,
  plannedStepId: "PS-2",
  kind: "act",
  instruction: "Click Add to cart",
  element,
  inputRef: null,
  onGoldenPath: true,
  urlBefore: "https://shop.example.com/products/1",
  urlAfter: "https://shop.example.com/products/1",
  outcome: "SUCCESS",
  blockReason: null,
  error: null,
  startedAt: "2026-09-26T10:00:00.000Z",
  durationMs: 12,
  artifactIds: [],
  llm: { model: "claude-sonnet-5", inputTokens: 10, outputTokens: 2, cacheHit: null },
  ...over,
});

describe("ExplorationStepRepository", () => {
  it("stores validated steps and lists them in index order", async () => {
    const run = await newRun();
    const repo = new ExplorationStepRepository(tdb.db);
    await repo.insert(stepOf(run.id, 1, { kind: "observe", onGoldenPath: false }));
    await repo.insert(stepOf(run.id, 0, { kind: "navigate", element: null }));
    const steps = await repo.listByRun(run.id);
    expect(steps.map((s) => [s.index, s.kind])).toEqual([
      [0, "navigate"],
      [1, "observe"],
    ]);
    expect(steps[1]).toEqual(stepOf(run.id, 1, { kind: "observe", onGoldenPath: false }));
    expect(await repo.listByRun("run_other")).toEqual([]);
  });

  it("rejects invalid JSON on write and on read (contracts)", async () => {
    const run = await newRun();
    const repo = new ExplorationStepRepository(tdb.db);
    await expect(repo.insert({ ...stepOf(run.id, 0), kind: "dance" } as never)).rejects.toThrow();
    await expect(repo.insert({ ...stepOf(run.id, 0), index: -1 })).rejects.toThrow(/index/);
    await tdb.db.insert(explorationSteps).values({ id: "step_bad", runId: run.id, index: 5, json: { nope: true } });
    await expect(repo.listByRun(run.id)).rejects.toThrow();
  });

  it("a step index is unique per run", async () => {
    const run = await newRun();
    const repo = new ExplorationStepRepository(tdb.db);
    await repo.insert(stepOf(run.id, 0));
    await expect(repo.insert({ ...stepOf(run.id, 0), id: "step_dup" })).rejects.toThrow();
  });
});

describe("ObservedFactRepository", () => {
  const fact = (runId: string, over: Partial<ObservedFact> = {}): ObservedFact => ({
    key: "cartCount",
    checkpoint: "after_add",
    value: 1,
    provenance: "DOM_VERIFIED",
    read: { element, mode: "number" },
    modelValue: 1,
    stepId: `step_${runId}_7`,
    ...over,
  });

  it("upserts one fact per (key, checkpoint) and lists them", async () => {
    const run = await newRun();
    const repo = new ObservedFactRepository(tdb.db);
    await repo.upsert(run.id, { key: "url", checkpoint: "after_add", value: "https://shop.example.com/", provenance: "DOM_VERIFIED", read: null, stepId: "s" });
    await repo.upsert(run.id, fact(run.id, { value: 2, provenance: "MODEL_EXTRACTED", modelValue: 2, domValue: 1 }));
    await repo.upsert(run.id, fact(run.id)); // a retried checkpoint replaces its facts
    const facts = await repo.listByRun(run.id);
    expect(facts).toHaveLength(2);
    expect(facts.find((f) => f.key === "cartCount")).toEqual(fact(run.id));
  });

  it("validates facts (DOM_VERIFIED needs a read) on write and on read", async () => {
    const run = await newRun();
    const repo = new ObservedFactRepository(tdb.db);
    await expect(repo.upsert(run.id, fact(run.id, { read: null }))).rejects.toThrow(/read/);
  });
});
