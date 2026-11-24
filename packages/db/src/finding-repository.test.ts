import type { StoredFinding } from "@platform/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FindingRepository } from "./finding-repository";
import { RunRepository } from "./run-repository";
import { storedRequest } from "./test-helpers";
import { OTHER_TENANT_ID, TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "./testing";

let tdb: TestDatabase;
let runs: RunRepository;
let findings: FindingRepository;
beforeAll(async () => {
  tdb = await createTestDatabase();
  runs = new RunRepository(tdb.db);
  findings = new FindingRepository(tdb.db);
});
afterAll(async () => tdb?.drop());

const finding = (id: string, title = "Help link opens a missing page"): StoredFinding => ({
  id, source: "browser_use", title,
  observation: "The Help link in the footer opened a page that says Not Found.",
  expected: "The help page opens", path: "/help", url: "https://shop.example.com/help",
  reproduction: ["Open the home page", "Click Help in the footer"], severity: "medium",
  dismissedAt: null, reproductionRunId: null, createdAt: "2026-11-24T00:00:00.000Z",
});

describe("FindingRepository (Phase C)", () => {
  it("stores a job's findings once, so a retried job never replaces a reviewed one", async () => {
    const run = await runs.create({ tenantId: OTHER_TENANT_ID, targetUrl: "https://shop.example.com", request: storedRequest() });
    expect(await findings.saveNew(run.id, [finding("F-1"), finding("F-2", "Search returns nothing")])).toBe(2);
    await findings.update(run.id, { ...finding("F-1"), dismissedAt: "2026-11-24T01:00:00.000Z" });
    expect(await findings.saveNew(run.id, [finding("F-1", "A retried job's text")])).toBe(0);
    const stored = await findings.list(run.id);
    expect(stored.map((f) => [f.id, f.title, f.dismissedAt])).toEqual([
      ["F-1", "Help link opens a missing page", "2026-11-24T01:00:00.000Z"],
      ["F-2", "Search returns nothing", null],
    ]);
    expect(await findings.get(run.id, "F-3")).toBeNull();
    // The row carries the run's tenant, set by the database.
    const { rows } = await tdb.pool.query<{ tenant_id: string }>("SELECT DISTINCT tenant_id FROM run_findings WHERE run_id = $1", [run.id]);
    expect(rows.map((r) => r.tenant_id)).toEqual([OTHER_TENANT_ID]);
  });

  it("refuses a finding that breaks the contract and deletes findings with their run", async () => {
    const run = await runs.create({ tenantId: TEST_TENANT_ID, targetUrl: "https://shop.example.com", request: storedRequest() });
    await expect(findings.saveNew(run.id, [{ ...finding("F-9") }])).rejects.toThrow();
    await findings.saveNew(run.id, [finding("F-1")]);
    await tdb.pool.query("DELETE FROM test_runs WHERE id = $1", [run.id]);
    expect(await findings.list(run.id)).toEqual([]);
  });
});
