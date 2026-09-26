// @vitest-environment node
import { describe, expect, it } from "vitest";
import config from "./next.config";

describe("next.config", () => {
  it("forbids framing every page (clickjacking)", async () => {
    const rules = await config.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    expect(all).toBeDefined();
    expect(all!.headers).toEqual(
      expect.arrayContaining([
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      ]),
    );
  });
});
