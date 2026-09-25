import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestApi, validBody, type TestApi } from "../test-support";

let t: TestApi;
beforeAll(async () => {
  t = await createTestApi({ maxActiveRunsPerTenant: 2 });
});
afterAll(async () => t?.close());

describe("per-tenant active run cap", () => {
  it("holds under concurrent creates", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        t.app.inject({ method: "POST", url: "/v1/test-runs", headers: auth, payload: validBody() }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 202)).toHaveLength(2);
    expect(codes.filter((c) => c === 429)).toHaveLength(6);
  });
});
