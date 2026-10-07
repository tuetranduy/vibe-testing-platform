import { describe, expect, it } from "vitest";
import * as security from "./index";

describe("@platform/security public API", () => {
  it("re-exports every module", () => {
    for (const name of [
      "classifyAddress",
      "isPublicAddress",
      "defaultResolver",
      "validateTargetUrl",
      "isHostPortAllowlisted",
      "redactByKey",
      "createRunRedactor",
      "isSensitiveKey",
      "REDACTED",
      "encryptSecret",
      "decryptSecret",
      "assertActionAllowed",
      "DESTRUCTIVE_TERMS",
      "secretFingerprint",
    ]) {
      expect(security, name).toHaveProperty(name);
    }
  });

  it("action denial reason is a contracts BlockReason", async () => {
    const { BlockReasonSchema } = await import("@platform/contracts");
    const d = security.assertActionAllowed({ instruction: "delete" }, { allowDestructive: false });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(BlockReasonSchema.parse(d.reason)).toBe("DESTRUCTIVE_ACTION_NOT_AUTHORIZED");
  });
});
