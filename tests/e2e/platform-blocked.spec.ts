import { VALID_EMAIL, VALID_PASSWORD } from "@platform/demo-shop";
import { afterAll, describe, expect, inject, it } from "vitest";
import { api, db } from "./support/client";
import { REQUIREMENTS } from "./support/scenarios";

const stack = inject("e2e");
const client = api(stack);
const store = db(stack);
afterAll(() => store.close());

describe("Task 21 step 3 — BLOCKED / secrets", () => {
  it("without the password secret: BLOCKED / MISSING_SECRET, verdict BLOCKED", async () => {
    const runId = await client.create({
      targetUrl: `${stack.targetUrl}/`,
      requirement: REQUIREMENTS.account,
      testData: { email: VALID_EMAIL },
      options: { autoConfirmCriteria: true },
    });
    expect(await client.finished(runId)).toMatchObject({ lifecycle: "COMPLETED", verdict: "BLOCKED" });
    const report = await client.report(runId);
    expect(report.criteria.length).toBeGreaterThan(0);
    for (const c of report.criteria) expect(c).toMatchObject({ status: "BLOCKED", reason: "MISSING_SECRET" });
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
