import type { GeneratedTest } from "@platform/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GeneratedTestRepository } from "./generated-test-repository";
import { RunRepository } from "./run-repository";
import { generatedTests } from "./schema";
import { storedRequest } from "./test-helpers";
import { TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "./testing";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => tdb?.drop());

const newRun = () => new RunRepository(tdb.db).create({ tenantId: TEST_TENANT_ID, targetUrl: "https://shop.example.com", request: storedRequest() });

const generated = (id: string, over: Partial<GeneratedTest> = {}): GeneratedTest => ({
  id,
  source: 'import { test } from "@playwright/test";\n',
  helpersSource: "export {};\n",
  dataJson: JSON.stringify({ targetUrl: "https://shop.example.com/" }),
  compiledCriteria: ["AC-1"],
  notCompiled: [{ criterionId: "AC-2", reason: "Provisional result is BLOCKED (MISSING_SECRET)" }],
  notes: ["Step 4 (act) is located by XPath only (brittle-locator)"],
  ...over,
});

describe("GeneratedTestRepository (Ruling R28)", () => {
  it("saves a validated generated test and finds it by run", async () => {
    const run = await newRun();
    const repo = new GeneratedTestRepository(tdb.db);
    expect(await repo.findByRun(run.id)).toBeNull();
    const test = generated(`gt_${run.id}`);
    expect(await repo.save(run.id, test)).toEqual(test);
    expect(await repo.findByRun(run.id)).toEqual(test);
    expect(await repo.findByRun("run_other")).toBeNull();
  });

  it("one generated test per run", async () => {
    const run = await newRun();
    const repo = new GeneratedTestRepository(tdb.db);
    await repo.save(run.id, generated(`gt_a_${run.id}`));
    await expect(repo.save(run.id, generated(`gt_b_${run.id}`))).rejects.toThrow();
  });

  it("rejects invalid data on write and on read (contracts)", async () => {
    const run = await newRun();
    const repo = new GeneratedTestRepository(tdb.db);
    await expect(repo.save(run.id, generated("gt_bad", { compiledCriteria: ["criterion one"] }))).rejects.toThrow();
    await tdb.db.insert(generatedTests).values({
      id: `gt_raw_${run.id}`,
      runId: run.id,
      source: "",
      helpersSource: "",
      dataJson: "{}",
      compiledCriteria: [42],
      notCompiled: [],
      notes: [],
    });
    await expect(repo.findByRun(run.id)).rejects.toThrow();
  });
});
