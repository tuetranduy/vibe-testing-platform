import type { EventDraft } from "@platform/testing-engine";
import { describe, expect, it } from "vitest";
import { createEgressEventReporter } from "./egress-events";

const flush = () => new Promise((r) => setImmediate(r));

function setup(opts: { maxEvents?: number; failPublish?: boolean } = {}) {
  const published: EventDraft[] = [];
  const warnings: { obj: object; msg?: string }[] = [];
  const report = createEgressEventReporter({
    publish: async (e) => {
      if (opts.failPublish) throw new Error("db down");
      published.push(e);
    },
    logger: { warn: (obj, msg) => warnings.push({ obj, msg }) },
    maxEvents: opts.maxEvents,
  });
  return { report, published, warnings };
}

describe("egress.blocked event reporter", () => {
  it("publishes a template-built event with host and reason only", async () => {
    const { report, published } = setup();
    report({ host: "169.254.169.254", port: 80, reason: "NON_PUBLIC_ADDRESS" });
    report({ host: "::1", port: 443, reason: "NON_PUBLIC_ADDRESS" });
    await flush();
    expect(published).toEqual([
      {
        type: "egress.blocked",
        message: "Blocked network access to 169.254.169.254:80 (NON_PUBLIC_ADDRESS)",
        payload: { host: "169.254.169.254", reason: "NON_PUBLIC_ADDRESS" },
      },
      {
        type: "egress.blocked",
        message: "Blocked network access to [::1]:443 (NON_PUBLIC_ADDRESS)",
        payload: { host: "::1", reason: "NON_PUBLIC_ADDRESS" },
      },
    ]);
  });

  it("publishes each host:port + reason once", async () => {
    const { report, published } = setup();
    for (let i = 0; i < 5; i++) report({ host: "10.0.0.1", port: 80, reason: "NON_PUBLIC_ADDRESS" });
    report({ host: "10.0.0.1", port: 81, reason: "NON_PUBLIC_ADDRESS" });
    await flush();
    expect(published.map((e) => e.message)).toEqual([
      "Blocked network access to 10.0.0.1:80 (NON_PUBLIC_ADDRESS)",
      "Blocked network access to 10.0.0.1:81 (NON_PUBLIC_ADDRESS)",
    ]);
  });

  it("does not publish Chromium background-service denials", async () => {
    const { report, published } = setup();
    report({ host: "accounts.google.com", port: 443, reason: "BACKGROUND_SERVICE_DENIED" });
    await flush();
    expect(published).toEqual([]);
  });

  it("caps events per run: after N distinct blocks, one summary event, then nothing", async () => {
    const { report, published } = setup({ maxEvents: 3 });
    // A page flooding unique hosts (r1.x.invalid, r2.x.invalid, …).
    for (let i = 1; i <= 1000; i++) report({ host: `r${i}.x.invalid`, port: 443, reason: "DNS_RESOLUTION_FAILED" });
    report({ host: "169.254.169.254", port: 80, reason: "NON_PUBLIC_ADDRESS" });
    await flush();

    expect(published).toHaveLength(4);
    expect(published.slice(0, 3).map((e) => (e.type === "egress.blocked" ? e.payload.host : null))).toEqual([
      "r1.x.invalid",
      "r2.x.invalid",
      "r3.x.invalid",
    ]);
    expect(published[3]).toEqual({
      type: "egress.blocked",
      message: "Further blocked network requests were not reported",
      payload: { host: "*", reason: "SUPPRESSED" },
    });
  });

  it("defaults to a small cap", async () => {
    const { report, published } = setup();
    for (let i = 1; i <= 500; i++) report({ host: `r${i}.x.invalid`, port: 443, reason: "DNS_RESOLUTION_FAILED" });
    await flush();
    expect(published.length).toBeLessThanOrEqual(21);
    expect(published.at(-1)?.message).toBe("Further blocked network requests were not reported");
  });

  it("logs publish failures instead of swallowing them", async () => {
    const { report, warnings } = setup({ failPublish: true });
    report({ host: "10.0.0.1", port: 80, reason: "NON_PUBLIC_ADDRESS" });
    await flush();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toBe("failed to publish egress.blocked event");
    expect(warnings[0]?.obj).toMatchObject({ host: "10.0.0.1", reason: "NON_PUBLIC_ADDRESS" });
    expect((warnings[0]?.obj as { err?: unknown }).err).toBeInstanceOf(Error);
  });
});
