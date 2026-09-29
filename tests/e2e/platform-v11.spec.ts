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
