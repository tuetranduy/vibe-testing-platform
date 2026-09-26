import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiagnosticFindingRepository } from "./diagnostic-finding-repository";
import { RunRepository } from "./run-repository";
import { storedRequest } from "./test-helpers";
import { TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "./testing";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => tdb?.drop());

const newRun = () => new RunRepository(tdb.db).create({ tenantId: TEST_TENANT_ID, targetUrl: "https://shop.example.com", request: storedRequest() });

describe("DiagnosticFindingRepository (Task 18)", () => {
  it("stores a run's findings and lists them in insertion order", async () => {
    const run = await newRun();
    const other = await newRun();
    const repo = new DiagnosticFindingRepository(tdb.db);
    const findings = [
      { criterionId: "AC-2", summary: "The badge did not change." },
      { criterionId: null, summary: "The rerun failed on AC-2 only." },
      { criterionId: "AC-1", summary: "Third." },
    ];
    await repo.insertMany(run.id, findings);
    await repo.insertMany(other.id, [{ criterionId: null, summary: "Other run" }]);
    await repo.insertMany(run.id, []);
    expect(await repo.listByRun(run.id)).toEqual(findings);
    expect(await repo.listByRun("run_missing")).toEqual([]);
  });

  it("rejects findings that break the report contract", async () => {
    const run = await newRun();
    const repo = new DiagnosticFindingRepository(tdb.db);
    await expect(repo.insertMany(run.id, [{ criterionId: "criterion one", summary: "x" }])).rejects.toThrow();
    await expect(repo.insertMany(run.id, [{ criterionId: null, summary: "x".repeat(2001) }])).rejects.toThrow();
    expect(await repo.listByRun(run.id)).toEqual([]);
  });
});
