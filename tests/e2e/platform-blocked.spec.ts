import { VALID_EMAIL, VALID_PASSWORD } from "@platform/demo-shop";
import { afterAll, describe, expect, inject, it } from "vitest";
import { api, db, logs } from "./support/client";
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
    const rows = await store.rowsOf(runId);
    const events = JSON.stringify(await store.events(runId));
    const logText = logs(stack);
    for (const text of [rows, events, logText]) expect(text).toContain(runId);
    expect(rows).not.toContain(VALID_PASSWORD);
    expect(events).not.toContain(VALID_PASSWORD);
    expect(logText).not.toContain(VALID_PASSWORD);
    expect(await store.secretsActive(runId)).toEqual([]);

    const artifacts = await store.artifacts(runId);
    for (const a of artifacts.filter((x) => x.sensitivity === "STANDARD")) {
      const signed = await client.artifactUrl(runId, a.id);
      expect(Buffer.from(await (await fetch(signed.url)).arrayBuffer()).toString("latin1")).not.toContain(VALID_PASSWORD);
    }
    // A run with a secret stores its evidence as SECRET_BEARING.
    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts.every((a) => a.sensitivity === "SECRET_BEARING")).toBe(true);
  });
});
