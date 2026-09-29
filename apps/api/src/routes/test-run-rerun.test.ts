import type { GeneratedTest, NormalizedRequirement } from "@platform/contracts";
import { GeneratedTestRepository, RequirementRepository, RunRepository, SecretRepository, schema } from "@platform/db";
import { TEST_TENANT_ID } from "@platform/db/testing";
import { decryptSecret } from "@platform/security";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SECRETS_KEY, auth, createTestApi, validBody, type TestApi } from "../test-support";

let t: TestApi;
beforeAll(async () => {
  t = await createTestApi();
});
afterAll(async () => t?.close());
beforeEach(() => {
  t.queue.fail = false;
});

const call = (method: "GET" | "POST", url: string, payload?: object, headers: Record<string, string> = auth) =>
  t.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

const REQUIREMENT = "Verify that a user can add a product to the cart.";
const confirmed = (runId: string): NormalizedRequirement => ({
  runId,
  revision: 1,
  originalText: REQUIREMENT,
  criteria: [
    {
      id: "AC-1",
      sourceText: "add a product to the cart",
      statement: "The cart count is 1",
      expectedOutcome: { kind: "numeric_compare", left: { key: "cartCount", checkpoint: "after_add" }, operator: "eq", right: 1 },
      preconditions: [],
      critical: true,
      ambiguity: null,
    },
  ],
  facts: [{ key: "cartCount", checkpoint: "after_add", description: "Cart count", valueType: "number" }],
  confirmedAt: "2026-09-29T10:00:00.000Z",
});
const generated: GeneratedTest = {
  id: "gt_src",
  source: "// the saved test",
  helpersSource: "",
  dataJson: "{}",
  compiledCriteria: ["AC-1"],
  notCompiled: [],
  notes: [],
};

/** A finished (CANCELLED) run with a confirmed requirement and a generated test, created through the API. */
async function finishedSource(body: Record<string, unknown> = {}, opts: { test?: GeneratedTest | null } = {}): Promise<string> {
  const { runId } = (await call("POST", "/v1/test-runs", validBody({ requirement: REQUIREMENT, ...body }))).json();
  await new RequirementRepository(t.tdb.db).copyConfirmed(runId, confirmed(runId));
  if (opts.test !== null) await new GeneratedTestRepository(t.tdb.db).save(runId, { ...(opts.test ?? generated), id: `gt_${runId}` });
  await new RunRepository(t.tdb.db).transition(runId, "QUEUED", "CANCELLED", { cancelReason: "USER_REQUESTED" });
  return runId;
}

describe("POST /v1/test-runs/:runId/rerun", () => {
  it("creates a QUEUED rerun that copies the source's confirmed criteria and saved test, and queues rerun-run", async () => {
    const source = await finishedSource();
    const res = await call("POST", `/v1/test-runs/${source}/rerun`, {});
    expect(res.statusCode).toBe(202);
    const { runId } = res.json();
    expect(runId).not.toBe(source);
    expect(t.queue.rerun).toContain(runId);
    expect(t.queue.analyze).not.toContain(runId);

    const summary = (await call("GET", `/v1/test-runs/${runId}`)).json();
    expect(summary).toMatchObject({
      lifecycle: "QUEUED",
      kind: "rerun",
      sourceRunId: source,
      requirementPreview: REQUIREMENT,
      secretNames: [],
    });

    const requirement = await new RequirementRepository(t.tdb.db).getLatest(runId);
    expect(requirement).toMatchObject({ runId, revision: 1, criteria: confirmed(source).criteria });
    expect(requirement.confirmedAt).not.toBeNull();
    const test = await new GeneratedTestRepository(t.tdb.db).findByRun(runId);
    expect(test).toMatchObject({ source: "// the saved test", compiledCriteria: ["AC-1"] });
    expect(test!.id).not.toBe(`gt_${source}`);
  });

  it("needs every secret the source had, again; typed or through saved credentials", async () => {
    const source = await finishedSource({ secrets: { password: "first-password" } });
    const missing = await call("POST", `/v1/test-runs/${source}/rerun`, {});
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toMatchObject({
      code: "SECRETS_REQUIRED",
      issues: [{ path: ["secrets", "password"], message: "Enter password again: secret values are deleted when a run ends" }],
    });

    const typed = await call("POST", `/v1/test-runs/${source}/rerun`, { secrets: { password: "second-password", extra: "ignored-value" } });
    expect(typed.statusCode).toBe(202);
    const runId = typed.json().runId;
    const secrets = await new SecretRepository(t.tdb.db).listActive(runId);
    expect(secrets.map((s) => [s.name, decryptSecret(s, { runId, name: s.name }, SECRETS_KEY)])).toEqual([["password", "second-password"]]);

    const profile = (
      await call("POST", "/v1/credential-profiles", { name: "Rerun login", secrets: { password: "profile-password" } })
    ).json();
    const viaProfile = await call("POST", `/v1/test-runs/${source}/rerun`, { credentialProfileId: profile.id });
    expect(viaProfile.statusCode).toBe(202);
    const [row] = await t.tdb.db.select().from(schema.testRuns).where(eq(schema.testRuns.id, viaProfile.json().runId));
    expect(row!.requestJson).toMatchObject({
      rerunOf: source,
      credentialProfile: { id: profile.id, name: "Rerun login" },
      secretNames: ["password"],
    });
  });

  it("refuses a run still going (409), one without a saved test (409), and an unknown run (404)", async () => {
    const { runId: active } = (await call("POST", "/v1/test-runs", validBody())).json();
    expect((await call("POST", `/v1/test-runs/${active}/rerun`, {})).json().code).toBe("RUN_NOT_FINISHED");
    const noTest = await finishedSource({}, { test: null });
    const res = await call("POST", `/v1/test-runs/${noTest}/rerun`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("NOTHING_TO_RERUN");
    const empty = await finishedSource(
      {},
      { test: { ...generated, compiledCriteria: [], notCompiled: [{ criterionId: "AC-1", reason: "x" }] } },
    );
    expect((await call("POST", `/v1/test-runs/${empty}/rerun`, {})).json().code).toBe("NOTHING_TO_RERUN");
    expect((await call("POST", "/v1/test-runs/run_missing/rerun", {})).statusCode).toBe(404);
  });

  it("replays an Idempotency-Key instead of creating a second rerun", async () => {
    const source = await finishedSource();
    const headers = { ...auth, "idempotency-key": `rerun-${source}` };
    const first = await call("POST", `/v1/test-runs/${source}/rerun`, {}, headers);
    const again = await call("POST", `/v1/test-runs/${source}/rerun`, {}, headers);
    expect(again.json().runId).toBe(first.json().runId);
  });

  it("a rerun of a rerun points at the run it was started from", async () => {
    const source = await finishedSource();
    const first = (await call("POST", `/v1/test-runs/${source}/rerun`, {})).json().runId;
    await new RunRepository(t.tdb.db).transition(first, "QUEUED", "CANCELLED", { cancelReason: "USER_REQUESTED" });
    const second = await call("POST", `/v1/test-runs/${first}/rerun`, {});
    expect(second.statusCode).toBe(202);
    expect((await call("GET", `/v1/test-runs/${second.json().runId}`)).json().sourceRunId).toBe(first);
  });

  it("marks the rerun ERRORED and answers 503 when the queue is down", async () => {
    const source = await finishedSource();
    t.queue.fail = true;
    const res = await call("POST", `/v1/test-runs/${source}/rerun`, {});
    expect(res.statusCode).toBe(503);
    const [newest] = (await new RunRepository(t.tdb.db).list(TEST_TENANT_ID, { limit: 1 })).items;
    expect(newest).toMatchObject({ lifecycle: "ERRORED", errorCategory: "INTERNAL" });
  });
});
