import type { LlmExchange } from "@platform/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LlmCallRepository } from "./llm-call-repository";
import { LlmExchangeRepository } from "./llm-exchange-repository";
import { RunRepository } from "./run-repository";
import { storedRequest } from "./test-helpers";
import { OTHER_TENANT_ID, TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "./testing";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => tdb?.drop());

const exchange: LlmExchange = {
  system: "You are a tester.",
  messages: [{ role: "user", content: "x".repeat(50_000) }],
  response: '{"ok":true}',
  error: null,
  truncated: false,
};

async function newCall(tenantId = TEST_TENANT_ID) {
  const run = await new RunRepository(tdb.db).create({ tenantId, targetUrl: "https://x.com", request: storedRequest() });
  const call = await new LlmCallRepository(tdb.db).create({
    runId: run.id,
    stage: "EXPLORING",
    provider: "anthropic",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    estimatedCostUsd: 0,
    latencyMs: 1,
    status: "SUCCESS",
    purpose: "Observation",
  });
  return { run, call };
}

describe("LlmExchangeRepository", () => {
  it("exchange round-trips through gzip", async () => {
    const { run, call } = await newCall();
    const repo = new LlmExchangeRepository(tdb.db);
    await repo.put(call.id, run.id, exchange);
    expect(await repo.get(TEST_TENANT_ID, call.id)).toEqual(exchange);
    expect(call.purpose).toBe("Observation");
  });

  it("stores the body compressed", async () => {
    const { run, call } = await newCall();
    const repo = new LlmExchangeRepository(tdb.db);
    await repo.put(call.id, run.id, exchange);
    const bytes = await repo.storedBytes(call.id);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(5_000);
  });

  it("get returns null for another tenant", async () => {
    const { run, call } = await newCall(OTHER_TENANT_ID);
    const repo = new LlmExchangeRepository(tdb.db);
    await repo.put(call.id, run.id, exchange);
    expect(await repo.get(TEST_TENANT_ID, call.id)).toBeNull();
    expect(await repo.get(OTHER_TENANT_ID, call.id)).toEqual(exchange);
  });

  it("availability returns ids of calls that have an exchange", async () => {
    const { run, call } = await newCall();
    const other = await new LlmCallRepository(tdb.db).create({
      runId: run.id, stage: "EXPLORING", provider: "anthropic", model: "m",
      inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, latencyMs: 1, status: "SUCCESS",
    });
    const repo = new LlmExchangeRepository(tdb.db);
    await repo.put(call.id, run.id, exchange);
    expect([...(await repo.availability(run.id))]).toEqual([call.id]);
    expect(other.purpose).toBeNull();
  });

  it("deleteOlderThan removes old exchanges only", async () => {
    const { run, call } = await newCall();
    const repo = new LlmExchangeRepository(tdb.db);
    await repo.put(call.id, run.id, exchange);
    expect(await repo.deleteOlderThan(new Date("2000-01-01T00:00:00Z"), 100)).toBe(0);
    expect(await repo.deleteOlderThan(new Date(Date.now() + 60_000), 100)).toBeGreaterThanOrEqual(1);
    expect(await repo.get(TEST_TENANT_ID, call.id)).toBeNull();
  });
});
