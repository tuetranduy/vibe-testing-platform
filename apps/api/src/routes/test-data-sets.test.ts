import { schema } from "@platform/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestApi, validBody, type TestApi } from "../test-support";

let t: TestApi;
beforeAll(async () => {
  t = await createTestApi();
});
afterAll(async () => t?.close());

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  t.app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });

describe("/v1/test-data-sets", () => {
  it("creates, reads, lists, updates and deletes a set", async () => {
    const created = await call("POST", "/v1/test-data-sets", { name: "Shopper", values: { email: "qa@demo.test", quantity: 2 } });
    expect(created.statusCode).toBe(201);
    const set = created.json();
    expect(set).toMatchObject({ name: "Shopper", values: { email: "qa@demo.test", quantity: 2 }, createdBy: null });

    expect((await call("GET", `/v1/test-data-sets/${set.id}`)).json().name).toBe("Shopper");
    expect((await call("GET", "/v1/test-data-sets")).json().items.map((s: { id: string }) => s.id)).toContain(set.id);

    const updated = await call("PUT", `/v1/test-data-sets/${set.id}`, { name: "Shopper 2", values: { email: "qa2@demo.test" } });
    expect(updated.json()).toMatchObject({ name: "Shopper 2", values: { email: "qa2@demo.test" } });

    expect((await call("DELETE", `/v1/test-data-sets/${set.id}`)).statusCode).toBe(204);
    expect((await call("GET", `/v1/test-data-sets/${set.id}`)).statusCode).toBe(404);
    expect((await call("DELETE", `/v1/test-data-sets/${set.id}`)).statusCode).toBe(404);
  });

  it("validates names and values, and refuses a duplicate name with 409", async () => {
    expect((await call("POST", "/v1/test-data-sets", { name: "", values: {} })).statusCode).toBe(400);
    const bad = await call("POST", "/v1/test-data-sets", { name: "Bad", values: { "has space": "x" } });
    expect(bad.statusCode).toBe(400);
    await call("POST", "/v1/test-data-sets", { name: "Same", values: {} });
    const dup = await call("POST", "/v1/test-data-sets", { name: "Same", values: {} });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().issues).toEqual([{ path: ["name"], message: "A test data set with this name already exists" }]);
  });
});

describe("POST /v1/test-runs with testDataSetId", () => {
  it("copies the set's values under the request's own and records the set", async () => {
    const set = (
      await call("POST", "/v1/test-data-sets", { name: "Buyer", values: { email: "set@demo.test", searchTerm: "iPhone" } })
    ).json();
    const res = await call("POST", "/v1/test-runs", validBody({ testDataSetId: set.id, testData: { email: "own@demo.test" } }));
    expect(res.statusCode).toBe(202);
    const [row] = await t.tdb.db.select().from(schema.testRuns).where(eq(schema.testRuns.id, res.json().runId));
    const stored = row!.requestJson as { testData: Record<string, string>; testDataSet: unknown; testDataSetId?: string };
    expect(stored.testData).toEqual({ email: "own@demo.test", searchTerm: "iPhone" });
    expect(stored.testDataSet).toEqual({ id: set.id, name: "Buyer" });
    expect(stored.testDataSetId).toBeUndefined();

    // Later edits of the set never change the run.
    await call("PUT", `/v1/test-data-sets/${set.id}`, { name: "Buyer", values: { searchTerm: "Pixel" } });
    const [again] = await t.tdb.db.select().from(schema.testRuns).where(eq(schema.testRuns.id, res.json().runId));
    expect((again!.requestJson as { testData: Record<string, string> }).testData.searchTerm).toBe("iPhone");
  });

  it("refuses an unknown set with 422 and a merged map over 50 entries with 400", async () => {
    const missing = await call("POST", "/v1/test-runs", validBody({ testDataSetId: "tds_missing" }));
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toMatchObject({ code: "TEST_DATA_SET_NOT_FOUND", issues: [{ path: ["testDataSetId"] }] });

    const values = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`set${i}`, "v"]));
    const own = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`own${i}`, "v"]));
    const set = (await call("POST", "/v1/test-data-sets", { name: "Big", values })).json();
    const tooMany = await call("POST", "/v1/test-runs", validBody({ testDataSetId: set.id, testData: own }));
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().issues[0].path).toEqual(["testData"]);
  });

  it("keeps the set's values as given, one that is also a secret value included (secrets are not redacted)", async () => {
    const set = (await call("POST", "/v1/test-data-sets", { name: "Leaky", values: { note: "pw is hunter2-long-secret" } })).json();
    const res = await call("POST", "/v1/test-runs", validBody({ testDataSetId: set.id, secrets: { password: "hunter2-long-secret" } }));
    const [row] = await t.tdb.db.select().from(schema.testRuns).where(eq(schema.testRuns.id, res.json().runId));
    expect((row!.requestJson as { testData: Record<string, string> }).testData.note).toBe("pw is hunter2-long-secret");
  });
});
