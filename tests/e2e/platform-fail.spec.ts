import { afterAll, describe, expect, inject, it } from "vitest";
import { api, db } from "./support/client";
import { REQUIREMENTS } from "./support/scenarios";

const stack = inject("e2e");
const client = api(stack);
const store = db(stack);
afterAll(() => store.close());

describe("Task 21 step 2 — FAIL", () => {
  it("?bug=empty_cart: the cart count still PASSES, the cart contents FAIL (rerun-confirmed); verdict FAILED; the failure keeps a trace and a screenshot", async () => {
    const runId = await client.create({ targetUrl: `${stack.targetUrl}/?bug=empty_cart`, requirement: REQUIREMENTS.cart, options: { autoConfirmCriteria: true } });

    expect(await client.finished(runId)).toMatchObject({ lifecycle: "COMPLETED", verdict: "FAILED" });
    const report = await client.report(runId);

    // The badge still counts: a cart-count check, when the model wrote one (live mode may check "add it to the cart"
    // another way), PASSes.
    const count = report.requirement!.criteria.find((c) => c.expectedOutcome.kind === "numeric_compare");
    if (stack.mode === "ci") expect(count, "a numeric_compare criterion").toBeDefined();
    if (count) expect(report.criteria.find((r) => r.criterionId === count.id)).toMatchObject({ status: "PASS", verdictSource: "PLAYWRIGHT_RERUN" });
    // The cart-contents check: the list check that fails (a model may also check the search results, which pass).
    const lists = report.requirement!.criteria.filter((c) => c.expectedOutcome.kind === "collection_contains").map((c) => c.id);
    const contents = report.criteria.find((r) => lists.includes(r.criterionId) && r.status === "FAIL")!;
    expect(contents, "a failing collection_contains criterion").toBeDefined();
    expect(contents).toMatchObject({ status: "FAIL", verdictSource: "PLAYWRIGHT_RERUN", rerunOutcome: "ASSERTION_FAILED" });

    // Evidence: the failed rerun keeps its trace and screenshot, and the failed criterion points at evidence.
    const artifacts = await store.artifacts(runId);
    const types = new Set(artifacts.map((a) => a.type));
    expect(types).toContain("TRACE");
    expect(types).toContain("SCREENSHOT");
    expect(contents.evidenceArtifactIds.length).toBeGreaterThan(0);
    for (const id of contents.evidenceArtifactIds) expect(artifacts.map((a) => a.id)).toContain(id);

    // The trace is downloadable through the API.
    const trace = artifacts.find((a) => a.type === "TRACE")!;
    const signed = await client.artifactUrl(runId, trace.id, false);
    expect((await fetch(signed.url)).status).toBe(200);
  });
});
