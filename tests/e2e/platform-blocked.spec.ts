import { VALID_EMAIL, VALID_PASSWORD } from "@platform/demo-shop";
import { afterAll, describe, expect, inject, it } from "vitest";
import { api, db, logs, secretForms } from "./support/client";
import { REQUIREMENTS } from "./support/scenarios";

const stack = inject("e2e");
const client = api(stack);
const store = db(stack);
afterAll(() => store.close());

describe("Task 21 step 3 — BLOCKED / secrets", () => {
  it("without the password secret: BLOCKED / MISSING_SECRET, verdict BLOCKED", async () => {
    const runId = await client.create({
      targetUrl: `${stack.shopUrl}/`,
      requirement: REQUIREMENTS.account,
      testData: { email: VALID_EMAIL },
      options: { autoConfirmCriteria: true },
    });
    expect(await client.finished(runId)).toMatchObject({ lifecycle: "COMPLETED", verdict: "BLOCKED" });
    const report = await client.report(runId);
    expect(report.criteria.length).toBeGreaterThan(0);
    for (const c of report.criteria) expect(c).toMatchObject({ status: "BLOCKED", reason: "MISSING_SECRET" });
  });

  it("with the secret: PASS; the value is absent from DB rows, events, logs and STANDARD artifacts; secrets are purged", async () => {
    const runId = await client.create({
      targetUrl: `${stack.shopUrl}/`,
      requirement: REQUIREMENTS.account,
      testData: { email: VALID_EMAIL },
      secrets: { password: VALID_PASSWORD },
      options: { autoConfirmCriteria: true },
    });
    expect(await client.finished(runId)).toMatchObject({ lifecycle: "COMPLETED", verdict: "PASSED" });
    for (const c of (await client.report(runId)).criteria) expect(c).toMatchObject({ status: "PASS", verdictSource: "PLAYWRIGHT_RERUN" });

    // Guards against a vacuous pass: each source really holds this run.
    const sources = { "DB rows": await store.rowsOf(runId), events: JSON.stringify(await store.events(runId)), logs: logs(stack) };
    for (const text of Object.values(sources)) expect(text).toContain(runId);
    // Not in any form the redactors mask (encoded forms are how a secret hides in URLs, bodies, traces).
    const forms = secretForms(VALID_PASSWORD);
    expect(forms.length).toBeGreaterThan(1);
    for (const [where, text] of Object.entries(sources)) {
      for (const form of forms) expect(text, `${where} contain ${JSON.stringify(form)}`).not.toContain(form);
    }
    expect(await store.secretsActive(runId)).toEqual([]);

    // A run with a secret stores all its evidence as SECRET_BEARING, so it has no STANDARD artifact that
    // could carry the value.
    const artifacts = await store.artifacts(runId);
    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts.filter((a) => a.sensitivity !== "SECRET_BEARING")).toEqual([]);
  });
});
