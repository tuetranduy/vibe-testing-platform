import { VALID_PASSWORD } from "@platform/demo-shop";
import { createRunQueue } from "@platform/event-bus";
import { Redis } from "ioredis";
import { afterAll, describe, expect, inject, it } from "vitest";
import { CancelWatcher } from "../../apps/worker/src/cancel-watcher";
import { silentLogger, type WorkerDeps } from "../../apps/worker/src/deps";
import { reapJob } from "../../apps/worker/src/jobs/reap";
import { api, db, shopRequests, shopStats } from "./support/client";
import { DEMO_SHOP_SUGGESTIONS, REQUIREMENTS } from "./support/scenarios";

const stack = inject("e2e");
const client = api(stack);
const store = db(stack);
afterAll(() => store.close());

/** A blank-requirement run on the demo shop, waited for until it offers its suggested tests. */
async function awaitingChoice(body: Record<string, unknown> = {}): Promise<string> {
  const runId = await client.create({ targetUrl: `${stack.targetUrl}/`, ...body });
  await client.waitFor(runId, (r) => r.lifecycle === "AWAITING_SELECTION", 90_000);
  return runId;
}

describe("Suggested tests (spec 2026-09-28-suggest-tests)", () => {
  it("a blank requirement surveys the shop read-only, waits for a choice, and runs the chosen test with its edited wording", async () => {
    const lastSeq = (await shopRequests(stack)).at(-1)?.seq ?? 0;
    const deleteClicks = (await shopStats(stack)).deleteClicks;

    const runId = await awaitingChoice({ options: { autoConfirmCriteria: true } });

    const set = (await client.suggestions(runId)).json;
    expect(set.pages.map((p: { url: string; status: string }) => [new URL(p.url).pathname, p.status])).toEqual([
      ["/", "READ"],
      ["/products", "READ"],
      ["/cart", "READ"],
      ["/login", "READ"],
      ["/products/1", "READ"],
      ["/products/2", "READ"],
    ]);
    expect(set.selected).toBeNull();
    if (stack.mode === "ci") expect(set.suggestions.map((s: { title: string }) => s.title)).toEqual(DEMO_SHOP_SUGGESTIONS.suggestions.map((s) => s.title));

    // Read-only: GETs of the chosen pages only; nothing submitted, no delete click.
    const during = (await shopRequests(stack)).filter((r) => r.seq > lastSeq);
    expect(during.filter((r) => r.method !== "GET")).toEqual([]);
    const paths = during.map((r) => r.path);
    expect(paths).toEqual(expect.arrayContaining(["/", "/products", "/cart", "/login", "/products/1", "/products/2"]));
    expect(paths).not.toContain("/products/3");
    expect((await shopStats(stack)).deleteClicks).toBe(deleteClicks);

    // Events: pages by path only; the suggestions by id and title only.
    const events = await store.events(runId);
    expect(events.filter((e) => e.type === "page.surveyed")).toHaveLength(6);
    expect(JSON.stringify(events.filter((e) => e.type === "page.surveyed"))).not.toContain("?");
    const proposed = JSON.stringify(events.find((e) => e.type === "suggestions.proposed"));
    for (const s of set.suggestions as { requirement: string }[]) expect(proposed).not.toContain(s.requirement);

    const chosen = await client.select(runId, { suggestionId: "S-1", requirement: REQUIREMENTS.cart });
    expect(chosen.status).toBe(202);
    expect(chosen.json).toMatchObject({ lifecycle: "ANALYZING_REQUIREMENT", requirementPreview: REQUIREMENTS.cart });

    const done = await client.finished(runId);
    expect(done.lifecycle).toBe("COMPLETED");
    if (stack.mode === "ci") expect(done.verdict).toBe("PASSED");
    expect((await client.report(runId)).requirement?.originalText).toBe(REQUIREMENTS.cart);
    expect((await client.suggestions(runId)).json.selected).toEqual({ suggestionId: "S-1", edited: true });
    expect((await store.events(runId)).find((e) => e.type === "suggestion.selected")?.payload).toEqual({ suggestionId: "S-1", edited: true });
  });

  it("'None of these': a run waiting for a choice is cancelled at once, its secrets purged", async () => {
    const runId = await awaitingChoice({ secrets: { password: VALID_PASSWORD } });
    const res = await client.cancel(runId);
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ lifecycle: "CANCELLED", cancelReason: "USER_REQUESTED" });
    expect(await store.secretsActive(runId)).toEqual([]);
    expect((await store.events(runId)).at(-1)).toMatchObject({ type: "run.cancelled", payload: { reason: "USER_REQUESTED" } });
  });

  // Last in this file: the fake clock (25 h ahead) also reaps any other run still open in the E2E database.
  it("an unchosen run past the TTL (fake clock, the worker's real reaper) ends CANCELLED / SELECTION_EXPIRED", async () => {
    const runId = await awaitingChoice();

    const redis = new Redis(stack.redisUrl);
    const queueConnection = new Redis(stack.redisUrl, { maxRetriesPerRequest: null });
    const watcher = new CancelWatcher(new Redis(stack.redisUrl, { maxRetriesPerRequest: null }));
    const queue = createRunQueue(queueConnection);
    try {
      // The same literal as platform-confirmation.spec.ts's (as B left it): the reaper uses no engine.
      const deps: WorkerDeps = {
        config: {
          secretsKey: Buffer.alloc(32),
          analysisTimeoutSeconds: 120,
          surveyTimeoutSeconds: 180,
          heartbeatMs: 10_000,
          staleAfterMs: 60_000,
          confirmationTtlHours: 24,
          queuedStaleAfterMs: 10 * 60_000,
          deadlineGraceMs: 60_000,
          timeScale: 1,
        },
        db: store.handle.db,
        redis,
        cancelWatcher: watcher,
        queue,
        engines: {} as WorkerDeps["engines"],
        runLlm: {} as WorkerDeps["runLlm"],
        logger: silentLogger,
        now: () => new Date(Date.now() + 25 * 3_600_000),
      };
      const reaped = await reapJob(deps);
      expect(reaped.selectionExpired).toContain(runId);
    } finally {
      await queue.close();
      watcher.close();
      redis.disconnect();
      queueConnection.disconnect();
    }

    expect(await client.get(runId)).toMatchObject({ lifecycle: "CANCELLED", cancelReason: "SELECTION_EXPIRED" });
    expect((await store.events(runId)).find((e) => e.type === "run.cancelled")?.payload).toEqual({ reason: "SELECTION_EXPIRED" });
  });
});
