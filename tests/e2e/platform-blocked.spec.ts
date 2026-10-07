import { VALID_EMAIL, VALID_PASSWORD } from "@platform/demo-shop";
import { afterAll, describe, expect, inject, it } from "vitest";
import { api, db } from "./support/client";
import { REQUIREMENTS } from "./support/scenarios";

const stack = inject("e2e");
const client = api(stack);
const store = db(stack);
afterAll(() => store.close());

describe("Task 21 step 3 — BLOCKED / secrets", () => {
  it("without the password secret: a password is generated and typed (not MISSING_SECRET); the shop refuses it: LOGIN_FAILED (2026-10-07)", async () => {
    const runId = await client.create({
      targetUrl: `${stack.targetUrl}/`,
      requirement: REQUIREMENTS.account,
      testData: { email: VALID_EMAIL },
      options: { autoConfirmCriteria: true },
    });
    expect(await client.finished(runId)).toMatchObject({ lifecycle: "COMPLETED" });
    const report = await client.report(runId);
    expect(report.criteria.length).toBeGreaterThan(0);
    // The run tried: the login with the invented password stayed on the login page.
    for (const c of report.criteria) expect(c).toMatchObject({ status: "BLOCKED", reason: "LOGIN_FAILED" });
    expect(report.generatedInputs).toEqual([{ source: "secret", key: "password", value: expect.any(String), stepId: expect.any(String) }]);
    // A made-up password cannot sign in to the demo shop's account.
    expect(report.generatedInputs[0]!.value).not.toBe(VALID_PASSWORD);
  });

  it("with the secret: PASS; secrets are purged; the evidence is STANDARD (secrets are not redacted since 2026-10-07)", async () => {
    const runId = await client.create({
      targetUrl: `${stack.targetUrl}/`,
      requirement: REQUIREMENTS.account,
      testData: { email: VALID_EMAIL },
      secrets: { password: VALID_PASSWORD },
      options: { autoConfirmCriteria: true },
    });
    expect(await client.finished(runId)).toMatchObject({ lifecycle: "COMPLETED", verdict: "PASSED" });
    for (const c of (await client.report(runId)).criteria) expect(c).toMatchObject({ status: "PASS", verdictSource: "PLAYWRIGHT_RERUN" });
    expect(await store.secretsActive(runId)).toEqual([]);

    const artifacts = await store.artifacts(runId);
    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts.filter((a) => a.sensitivity !== "STANDARD")).toEqual([]);
  });
});
