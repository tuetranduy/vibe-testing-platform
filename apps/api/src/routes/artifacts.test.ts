import { ArtifactRepository, RunRepository } from "@platform/db";
import { OTHER_TENANT_ID, TEST_TENANT_ID } from "@platform/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestApi, type TestApi } from "../test-support";

let t: TestApi;
beforeAll(async () => {
  t = await createTestApi();
});
afterAll(async () => t?.close());

const request = {
  targetUrl: "https://x.com",
  requirement: "Requirement text",
  environment: "staging" as const,
  browser: "chromium" as const,
  testData: {},
  secretNames: [],
  options: {} as never,
};

async function artifactFor(tenantId: string, sensitivity: "STANDARD" | "SECRET_BEARING") {
  const run = await new RunRepository(t.tdb.db).create({ tenantId, targetUrl: "https://x.com", request });
  const art = await new ArtifactRepository(t.tdb.db).create({
    tenantId,
    runId: run.id,
    type: "SCREENSHOT",
    objectKey: `tenants/${tenantId}/runs/${run.id}/screenshots/a-${Math.random().toString(16).slice(2)}.png`,
    sha256: "0".repeat(64),
    bytes: 10,
    contentType: "image/png",
    sensitivity,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return { run, art };
}

const url = (runId: string, artId: string, q = "") => `/v1/test-runs/${runId}/artifacts/${artId}/url${q}`;

describe("GET artifact URL", () => {
  it("returns a short-lived signed URL (TTL ≤ 300 s)", async () => {
    const { run, art } = await artifactFor(TEST_TENANT_ID, "STANDARD");
    const res = await t.app.inject({ method: "GET", url: url(run.id, art.id), headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.url).toContain(art.objectKey);
    expect(body.url).toContain("ttl=300");
    const ms = new Date(body.expiresAt).getTime() - Date.now();
    expect(ms).toBeLessThanOrEqual(300_000);
    expect(ms).toBeGreaterThan(290_000);
  });

  it("returns 404 for another tenant's artifact", async () => {
    const { run, art } = await artifactFor(OTHER_TENANT_ID, "STANDARD");
    expect((await t.app.inject({ method: "GET", url: url(run.id, art.id), headers: auth })).statusCode).toBe(404);
  });

  it("returns 404 when the artifact belongs to a different run", async () => {
    const a = await artifactFor(TEST_TENANT_ID, "STANDARD");
    const b = await artifactFor(TEST_TENANT_ID, "STANDARD");
    expect((await t.app.inject({ method: "GET", url: url(a.run.id, b.art.id), headers: auth })).statusCode).toBe(404);
  });

  it("serves a SECRET_BEARING artifact (recorded before 2026-10-07) without a reveal, and audits nothing", async () => {
    const { run, art } = await artifactFor(TEST_TENANT_ID, "SECRET_BEARING");
    expect((await t.app.inject({ method: "GET", url: url(run.id, art.id), headers: auth })).statusCode).toBe(200);
    // An older web app still sends reveal=true: accepted, ignored.
    expect((await t.app.inject({ method: "GET", url: url(run.id, art.id, "?reveal=true"), headers: auth })).statusCode).toBe(200);
    expect(t.audit).toHaveLength(0);
  });
});
