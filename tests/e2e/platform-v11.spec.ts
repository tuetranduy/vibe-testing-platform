import { VALID_EMAIL, VALID_PASSWORD } from "@platform/demo-shop";
import { afterAll, describe, expect, inject, it } from "vitest";
import { api, db, logs, secretForms } from "./support/client";
import { REQUIREMENTS } from "./support/scenarios";

const stack = inject("e2e");
const service = api(stack);
const store = db(stack);
afterAll(() => store.close());

async function signIn(email: string, password: string) {
  const res = await service.call("POST", "/v1/auth/login", { email, password });
  if (res.status !== 200) throw new Error(`login → ${res.status} ${res.text}`);
  return api(stack, res.json.token as string);
}

describe("V1.1 F1 — users and run ownership", () => {
  it("the bootstrap admin adds a member; each sees what their role allows", async () => {
    const admin = await signIn(stack.admin.email, stack.admin.password);
    const created = await admin.call("POST", "/v1/users", { email: "member@e2e.test", name: "Member", password: "member-password-1" });
    expect(created.status).toBe(201);
    const member = await signIn("member@e2e.test", "member-password-1");

    const body = { targetUrl: `${stack.targetUrl}/`, requirement: REQUIREMENTS.probe, options: { autoConfirmCriteria: true } };
    const adminRun = await admin.create(body);
    const memberRun = await member.create(body);
    await Promise.all([admin.finished(adminRun), member.finished(memberRun)]);

    expect((await member.get(memberRun)).owner).toEqual({ id: created.json.id, name: "Member" });
    expect((await member.call("GET", `/v1/test-runs/${adminRun}`)).status).toBe(404);
    expect((await member.call("GET", `/v1/test-runs/${adminRun}/report`)).status).toBe(404);
    const mine = (await member.call("GET", "/v1/test-runs?limit=100")).json.items.map((r: { runId: string }) => r.runId);
    expect(mine).toEqual([memberRun]);
    expect((await admin.call("GET", `/v1/test-runs/${memberRun}`)).status).toBe(200);
    expect((await member.call("PUT", "/v1/settings/llm", { defaults: { model: "fake", reasoning: "default" } })).status).toBe(403);
  });
});

describe("V1.1 F4 — saved credentials", () => {
  it("a run started with a saved profile passes like one with the typed secret, and keeps the value out of every record", async () => {
    const profile = await service.call("POST", "/v1/credential-profiles", {
      name: "Demo shop account",
      secrets: { password: VALID_PASSWORD },
    });
    expect(profile.status).toBe(201);
    const runId = await service.create({
      targetUrl: `${stack.targetUrl}/`,
      requirement: REQUIREMENTS.account,
      testData: { email: VALID_EMAIL },
      credentialProfileId: profile.json.id,
      options: { autoConfirmCriteria: true },
    });
    expect(await service.finished(runId)).toMatchObject({ lifecycle: "COMPLETED", verdict: "PASSED" });
    const sources = { "DB rows": await store.rowsOf(runId), events: JSON.stringify(await store.events(runId)), logs: logs(stack) };
    for (const [where, text] of Object.entries(sources)) {
      for (const form of secretForms(VALID_PASSWORD)) expect(text, `${where} contain ${JSON.stringify(form)}`).not.toContain(form);
    }
    expect(await store.secretsActive(runId)).toEqual([]);
  });
});

describe("V1.1 F5 — manual rerun", () => {
  it("reruns a passing run's saved test as a new run: rerun-confirmed PASS, no model call, the source untouched", async () => {
    const source = await service.create({
      targetUrl: `${stack.targetUrl}/`,
      requirement: REQUIREMENTS.cart,
      options: { autoConfirmCriteria: true },
    });
    expect(await service.finished(source)).toMatchObject({ lifecycle: "COMPLETED", verdict: "PASSED" });
    const sourceReport = await service.report(source);

    const res = await service.call("POST", `/v1/test-runs/${source}/rerun`, {});
    expect(res.status).toBe(202);
    const rerun = res.json.runId as string;
    expect(await service.finished(rerun)).toMatchObject({ lifecycle: "COMPLETED", verdict: "PASSED", kind: "rerun", sourceRunId: source });

    const report = await service.report(rerun);
    expect(report.rerunOf).toBe(source);
    expect(report.criteria.length).toBe(sourceReport.criteria.length);
    for (const c of report.criteria) expect(c).toMatchObject({ status: "PASS", verdictSource: "PLAYWRIGHT_RERUN", rerunOutcome: "PASSED" });
    expect(report.playwright?.status).toBe("PASSED");
    expect(await store.llmCalls(rerun)).toEqual([]);
    const stages = (await store.events(rerun)).filter((e) => e.type === "stage.started").map((e) => (e.payload as { stage: string }).stage);
    expect(stages).toEqual(["RUNNING_PLAYWRIGHT", "GENERATING_REPORT"]);
    expect(await service.report(source)).toEqual(sourceReport);
  });

  it("a run whose test needs a secret asks for it again", async () => {
    const source = await service.create({
      targetUrl: `${stack.targetUrl}/`,
      requirement: REQUIREMENTS.account,
      testData: { email: VALID_EMAIL },
      secrets: { password: VALID_PASSWORD },
      options: { autoConfirmCriteria: true },
    });
    expect(await service.finished(source)).toMatchObject({ lifecycle: "COMPLETED", verdict: "PASSED" });
    const missing = await service.call("POST", `/v1/test-runs/${source}/rerun`, {});
    expect(missing.status).toBe(422);
    expect(missing.json.code).toBe("SECRETS_REQUIRED");
    const res = await service.call("POST", `/v1/test-runs/${source}/rerun`, { secrets: { password: VALID_PASSWORD } });
    expect(await service.finished(res.json.runId)).toMatchObject({ lifecycle: "COMPLETED", verdict: "PASSED" });
    expect(await store.secretsActive(res.json.runId)).toEqual([]);
  });
});
