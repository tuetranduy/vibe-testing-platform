import { GeneratedTestRepository, RequirementRepository, RunRepository, SecretRepository, SuiteRunRepository } from "@platform/db";
import { decryptSecret } from "@platform/security";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SECRETS_KEY, auth, createTestApi, finishedRunWithTest, signInMember, type TestApi } from "../test-support";

let t: TestApi;
beforeAll(async () => {
  t = await createTestApi();
});
afterAll(async () => t?.close());
beforeEach(() => {
  t.queue.fail = false;
});

type Method = "GET" | "POST" | "PUT" | "DELETE";
const call = (method: Method, url: string, payload?: object, headers: Record<string, string> = auth) =>
  t.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

let n = 0;
const createSuite = async (body: Record<string, unknown> = {}, headers: Record<string, string> = auth) => {
  const res = await call("POST", "/v1/suites", { name: `Suite ${++n}`, ...body }, headers);
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; name: string };
};
const addEntry = (suiteId: string, sourceRunId: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = auth) =>
  call("POST", `/v1/suites/${suiteId}/entries`, { sourceRunId, ...extra }, headers);

async function complete(runId: string, verdict: "PASSED" | "FAILED") {
  const runs = new RunRepository(t.tdb.db);
  await runs.transition(runId, "QUEUED", "RUNNING_PLAYWRIGHT");
  await runs.transition(runId, "RUNNING_PLAYWRIGHT", "GENERATING_REPORT");
  await runs.transition(runId, "GENERATING_REPORT", "COMPLETED", { verdict });
}

describe("/v1/suites", () => {
  it("creates, lists, finds by name, renames and deletes a suite; names are unique regardless of case", async () => {
    const suite = await createSuite({ name: "Checkout smoke", description: "Paying" });
    expect(suite).toMatchObject({ name: "Checkout smoke", description: "Paying", entryCount: 0, entries: [], lastRun: null, credentialProfile: null });
    expect((await call("POST", "/v1/suites", { name: "CHECKOUT SMOKE" })).json().code).toBe("NAME_TAKEN");

    const byName = (await call("GET", "/v1/suites?name=checkout%20smoke")).json();
    expect(byName.items.map((s: { id: string }) => s.id)).toEqual([suite.id]);
    expect((await call("GET", "/v1/suites?name=nothing")).json().items).toEqual([]);

    const renamed = await call("PUT", `/v1/suites/${suite.id}`, { name: "Checkout" });
    expect(renamed.json()).toMatchObject({ name: "Checkout", description: "" });
    expect((await call("DELETE", `/v1/suites/${suite.id}`)).statusCode).toBe(204);
    expect((await call("GET", `/v1/suites/${suite.id}`)).statusCode).toBe(404);
  });

  it("refuses saved credentials that do not exist", async () => {
    const res = await call("POST", "/v1/suites", { name: "No such profile", credentialProfileId: "cpr_missing" });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("CREDENTIAL_PROFILE_NOT_FOUND");
  });

  it("adds finished runs' saved tests (a rerun adds the run that generated it), refuses what has no test or is added twice", async () => {
    const suite = await createSuite();
    const source = await finishedRunWithTest(t, { secrets: { password: "pw-long-enough" } });
    const res = await addEntry(suite.id, source);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      entryCount: 1,
      secretNames: ["password"],
      missingSecretNames: ["password"],
      entries: [{ sourceRunId: source, position: 1, compiledCriteria: 1, secretNames: ["password"], destructive: false, lastResult: null }],
    });

    const rerun = (await call("POST", `/v1/test-runs/${source}/rerun`, { secrets: { password: "pw-long-enough" } })).json().runId;
    await new RunRepository(t.tdb.db).transition(rerun, "QUEUED", "CANCELLED", { cancelReason: "USER_REQUESTED" });
    expect((await addEntry(suite.id, rerun)).json().code).toBe("ENTRY_EXISTS");

    const noTest = await finishedRunWithTest(t, {}, { test: null });
    expect((await addEntry(suite.id, noTest)).json().code).toBe("NOTHING_TO_RERUN");
    const active = (await call("POST", "/v1/test-runs", { targetUrl: "https://shop.example.com", requirement: "Something to check here" })).json().runId;
    expect((await addEntry(suite.id, active)).json().code).toBe("RUN_NOT_FINISHED");
    expect((await addEntry(suite.id, "run_missing")).statusCode).toBe(404);
  });

  it("needs the destructive-actions confirmation once, when the test is added", async () => {
    const suite = await createSuite();
    const source = await finishedRunWithTest(t, { options: { allowDestructiveActions: true } });
    const refused = await addEntry(suite.id, source);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe("CONFIRMATION_REQUIRED");
    const added = await addEntry(suite.id, source, { confirmDestructiveActions: true });
    expect(added.json().entries[0]).toMatchObject({ sourceRunId: source, destructive: true });
  });

  it("reorders only a full list of the suite's tests and removes one", async () => {
    const suite = await createSuite();
    const [a, b] = [await finishedRunWithTest(t), await finishedRunWithTest(t)];
    await addEntry(suite.id, a);
    await addEntry(suite.id, b);
    expect((await call("PUT", `/v1/suites/${suite.id}/entries/order`, { sourceRunIds: [b] })).statusCode).toBe(400);
    const reordered = await call("PUT", `/v1/suites/${suite.id}/entries/order`, { sourceRunIds: [b, a] });
    expect(reordered.json().entries.map((e: { sourceRunId: string }) => e.sourceRunId)).toEqual([b, a]);
    expect((await call("DELETE", `/v1/suites/${suite.id}/entries/${b}`)).statusCode).toBe(204);
    expect((await call("DELETE", `/v1/suites/${suite.id}/entries/${b}`)).statusCode).toBe(404);
    expect((await call("GET", `/v1/suites/${suite.id}`)).json().entries.map((e: { sourceRunId: string }) => e.sourceRunId)).toEqual([a]);
  });

  it("shows a member only their own suites, and lets them add only runs they can see", async () => {
    const ann = await signInMember(t);
    const bob = await signInMember(t);
    const annSuite = await createSuite({}, ann.headers);
    const adminSuite = await createSuite();
    const annRun = await finishedRunWithTest(t, {}, { headers: ann.headers });
    const adminRun = await finishedRunWithTest(t);

    expect((await call("GET", "/v1/suites", undefined, ann.headers)).json().items.map((s: { id: string }) => s.id)).toEqual([annSuite.id]);
    expect((await call("GET", `/v1/suites/${adminSuite.id}`, undefined, ann.headers)).statusCode).toBe(404);
    expect((await call("GET", `/v1/suites/${annSuite.id}`, undefined, bob.headers)).statusCode).toBe(404);
    expect((await addEntry(annSuite.id, adminRun, {}, ann.headers)).statusCode).toBe(404);
    expect((await addEntry(annSuite.id, annRun, {}, ann.headers)).statusCode).toBe(201);
    // An admin sees every suite, with its owner.
    const all = (await call("GET", "/v1/suites")).json().items as { id: string; owner: { id: string } | null }[];
    expect(all.find((s) => s.id === annSuite.id)?.owner?.id).toBe(ann.userId);
  });
});

describe("/v1/suites/:suiteId/runs", () => {
  it("reruns every test as its own run in one suite run, filling secrets from the request over the saved credentials", async () => {
    const profile = (
      await call("POST", "/v1/credential-profiles", { name: `Suite login ${++n}`, secrets: { password: "profile-pw-value", username: "profile-user" } })
    ).json();
    const suite = await createSuite({ credentialProfileId: profile.id });
    const withSecrets = await finishedRunWithTest(t, { secrets: { password: "old-pw-value", username: "old-user-value" } });
    const plain = await finishedRunWithTest(t);
    await addEntry(suite.id, withSecrets);
    await addEntry(suite.id, plain);
    expect((await call("GET", `/v1/suites/${suite.id}`)).json()).toMatchObject({ secretNames: ["password", "username"], missingSecretNames: [] });

    const res = await call("POST", `/v1/suites/${suite.id}/runs`, { secrets: { password: "typed-pw-value" } });
    expect(res.statusCode).toBe(202);
    const { suiteRunId, runIds } = res.json() as { suiteRunId: string; runIds: string[] };
    expect(runIds).toHaveLength(2);
    expect(t.queue.rerun).toEqual(expect.arrayContaining(runIds));
    // Queued by position in the suite, behind single runs (KI-038).
    expect(runIds.map((id) => t.queue.rerunPositions.get(id))).toEqual([0, 1]);

    const [first, second] = runIds.map((id) => id);
    const summary = (await call("GET", `/v1/test-runs/${first}`)).json();
    expect(summary).toMatchObject({ kind: "rerun", sourceRunId: withSecrets, suiteRunId, secretNames: ["password", "username"] });
    expect((await call("GET", `/v1/test-runs/${second}`)).json()).toMatchObject({ sourceRunId: plain, secretNames: [] });
    const secrets = await new SecretRepository(t.tdb.db).listActive(first!);
    const values = Object.fromEntries(secrets.map((s) => [s.name, decryptSecret(s, { runId: first!, name: s.name }, SECRETS_KEY)]));
    expect(values).toEqual({ password: "typed-pw-value", username: "profile-user" });
    expect(await new SecretRepository(t.tdb.db).listActive(second!)).toEqual([]);
    expect((await new GeneratedTestRepository(t.tdb.db).findByRun(first!))?.compiledCriteria).toEqual(["AC-1"]);
    expect((await new RequirementRepository(t.tdb.db).getLatest(first!)).confirmedAt).not.toBeNull();

    const view = (await call("GET", `/v1/suite-runs/${suiteRunId}`)).json();
    expect(view).toMatchObject({
      suiteId: suite.id,
      trigger: "manual",
      status: "RUNNING",
      verdict: null,
      counts: { total: 2, active: 2 },
      children: [
        { runId: first, sourceRunId: withSecrets, lifecycle: "QUEUED" },
        { runId: second, sourceRunId: plain, lifecycle: "QUEUED" },
      ],
    });
    expect(t.audit.some((e) => e.action === "credential_profile.used" && e.profileId === profile.id)).toBe(true);
  });

  it("names the secrets nothing provides, and refuses an empty suite", async () => {
    const suite = await createSuite();
    expect((await call("POST", `/v1/suites/${suite.id}/runs`, {})).json().code).toBe("SUITE_EMPTY");
    await addEntry(suite.id, await finishedRunWithTest(t, { secrets: { password: "pw-long-enough" } }));
    const res = await call("POST", `/v1/suites/${suite.id}/runs`, {});
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "SECRETS_REQUIRED", issues: [{ path: ["secrets", "password"] }] });
  });

  it("settles when the last child ends, and the suite shows its last run and each test's last result", async () => {
    const suite = await createSuite();
    const [a, b] = [await finishedRunWithTest(t), await finishedRunWithTest(t)];
    await addEntry(suite.id, a);
    await addEntry(suite.id, b);
    const { suiteRunId, runIds } = (await call("POST", `/v1/suites/${suite.id}/runs`, {})).json();
    await complete(runIds[0], "PASSED");
    expect((await call("GET", `/v1/suite-runs/${suiteRunId}`)).json()).toMatchObject({ status: "RUNNING", counts: { passed: 1, active: 1 } });
    await complete(runIds[1], "FAILED");
    expect((await call("GET", `/v1/suite-runs/${suiteRunId}`)).json()).toMatchObject({ status: "COMPLETED", verdict: "FAILED" });

    const detail = (await call("GET", `/v1/suites/${suite.id}`)).json();
    expect(detail.lastRun).toMatchObject({ id: suiteRunId, verdict: "FAILED" });
    expect(detail.entries.map((e: { lastResult: { verdict: string } }) => e.lastResult.verdict)).toEqual(["PASSED", "FAILED"]);
    expect((await call("GET", `/v1/suites/${suite.id}/runs`)).json().items.map((r: { id: string }) => r.id)).toEqual([suiteRunId]);
  });

  it("takes one active-run slot whatever its size", async () => {
    const small = await createTestApi({ maxActiveRunsPerTenant: 1 });
    try {
      const run = (m: Method, url: string, payload?: object) => small.app.inject({ method: m, url, headers: auth, ...(payload ? { payload } : {}) });
      const suite = (await run("POST", "/v1/suites", { name: "Big" })).json();
      for (let i = 0; i < 3; i++) await run("POST", `/v1/suites/${suite.id}/entries`, { sourceRunId: await finishedRunWithTest(small) });
      const started = await run("POST", `/v1/suites/${suite.id}/runs`, {});
      expect(started.statusCode).toBe(202);
      expect(started.json().runIds).toHaveLength(3);
      const second = await run("POST", `/v1/suites/${suite.id}/runs`, {});
      expect(second.statusCode).toBe(429);
    } finally {
      await small.close();
    }
  });

  it("replays an Idempotency-Key with the same body and refuses it with another", async () => {
    const suite = await createSuite();
    await addEntry(suite.id, await finishedRunWithTest(t));
    const headers = { ...auth, "idempotency-key": `suite-key-${++n}` };
    const first = await call("POST", `/v1/suites/${suite.id}/runs`, {}, headers);
    const again = await call("POST", `/v1/suites/${suite.id}/runs`, {}, headers);
    expect(again.json()).toEqual(first.json());
    const other = await call("POST", `/v1/suites/${suite.id}/runs`, { secrets: { extra: "something-else" } }, headers);
    expect(other.statusCode).toBe(409);
  });

  it("errors only the child that could not be queued", async () => {
    const suite = await createSuite();
    await addEntry(suite.id, await finishedRunWithTest(t));
    t.queue.fail = true;
    const { suiteRunId, runIds } = (await call("POST", `/v1/suites/${suite.id}/runs`, {})).json();
    expect((await call("GET", `/v1/test-runs/${runIds[0]}`)).json().lifecycle).toBe("ERRORED");
    // Its only child ended: the suite run is settled at once.
    expect((await call("GET", `/v1/suite-runs/${suiteRunId}`)).json()).toMatchObject({ status: "COMPLETED", verdict: "INCONCLUSIVE" });
  });

  it("cancels every active child", async () => {
    const suite = await createSuite();
    await addEntry(suite.id, await finishedRunWithTest(t));
    await addEntry(suite.id, await finishedRunWithTest(t));
    const { suiteRunId } = (await call("POST", `/v1/suites/${suite.id}/runs`, {})).json();
    const res = await call("POST", `/v1/suite-runs/${suiteRunId}/cancel`);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: "COMPLETED", verdict: "INCONCLUSIVE", counts: { noVerdict: 2 } });
    expect((await call("POST", `/v1/suite-runs/${suiteRunId}/cancel`)).json().code).toBe("RUN_TERMINAL");
  });

  it("belongs to whoever ran it: another member cannot see it or its runs", async () => {
    const ann = await signInMember(t);
    const bob = await signInMember(t);
    const suite = await createSuite({}, ann.headers);
    await addEntry(suite.id, await finishedRunWithTest(t, {}, { headers: ann.headers }), {}, ann.headers);
    const { suiteRunId, runIds } = (await call("POST", `/v1/suites/${suite.id}/runs`, {}, ann.headers)).json();
    expect((await call("GET", `/v1/suite-runs/${suiteRunId}`, undefined, ann.headers)).json().owner.id).toBe(ann.userId);
    expect((await call("GET", `/v1/suite-runs/${suiteRunId}`, undefined, bob.headers)).statusCode).toBe(404);
    expect((await call("GET", `/v1/test-runs/${runIds[0]}`, undefined, bob.headers)).statusCode).toBe(404);
    expect((await call("POST", `/v1/suites/${suite.id}/runs`, {}, bob.headers)).statusCode).toBe(404);
    expect(await new SuiteRunRepository(t.tdb.db).findById(suiteRunId)).toMatchObject({ ownerUserId: ann.userId });
  });
});
