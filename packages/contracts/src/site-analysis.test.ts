import { describe, expect, it } from "vitest";
import {
  ConfirmCriteriaRequestSchema,
  CreateTestRunRequestSchema,
  SiteAnalysisSchema,
  generateTestDataValue,
  isCredentialKey,
  keyWords,
  liveSiteAnalysisOn,
  traceRecordingOn,
  videoRecordingOn,
} from "./index";

describe("V1.3 run options", () => {
  const create = (options: object) => CreateTestRunRequestSchema.parse({ targetUrl: "https://shop.example.com/", requirement: "", options });

  it("records video and traces, and reads the live site, unless a run turns them off", () => {
    const defaults = create({});
    expect(defaults.options).not.toHaveProperty("recordVideo");
    expect(videoRecordingOn(defaults)).toBe(true);
    expect(traceRecordingOn(defaults)).toBe(true);
    expect(liveSiteAnalysisOn(defaults)).toBe(true);

    const off = create({ recordVideo: false, recordTrace: false, analyzeLiveSite: false });
    expect(videoRecordingOn(off)).toBe(false);
    expect(traceRecordingOn(off)).toBe(false);
    expect(liveSiteAnalysisOn(off)).toBe(false);
  });
});

describe("SiteAnalysisSchema", () => {
  const base = { status: "READ", reason: null, pages: [], checks: [], testData: [] };

  it("defaults the applied keys and accepts suggestions from the site or generated", () => {
    const parsed = SiteAnalysisSchema.parse({
      ...base,
      checks: [{ criterionId: "AC-1", status: "FOUND", note: "The Products page lists iPhone 17 Pro" }],
      testData: [
        { key: "productName", value: "iPhone 17 Pro", description: "A product the shop lists", source: "SITE" },
        { key: "quantity", value: 2, description: "How many to add", source: "GENERATED" },
      ],
    });
    expect(parsed.appliedKeys).toEqual([]);
    expect(parsed.testData).toHaveLength(2);
  });

  it("refuses an empty suggested value and a key that is not a test data key", () => {
    expect(SiteAnalysisSchema.safeParse({ ...base, testData: [{ key: "email", value: "", description: "", source: "GENERATED" }] }).success).toBe(false);
    expect(SiteAnalysisSchema.safeParse({ ...base, testData: [{ key: "1email", value: "x", description: "", source: "GENERATED" }] }).success).toBe(false);
  });
});

describe("ConfirmCriteriaRequestSchema", () => {
  it("takes an empty body and test data values", () => {
    expect(ConfirmCriteriaRequestSchema.parse({})).toEqual({ testData: {} });
    expect(ConfirmCriteriaRequestSchema.parse({ testData: { email: "a@example.com", quantity: 2 } }).testData).toEqual({
      email: "a@example.com",
      quantity: 2,
    });
  });

  it("refuses null values and bad keys", () => {
    expect(ConfirmCriteriaRequestSchema.safeParse({ testData: { email: null } }).success).toBe(false);
    expect(ConfirmCriteriaRequestSchema.safeParse({ testData: { "bad key": "x" } }).success).toBe(false);
  });
});

describe("generateTestDataValue", () => {
  it("splits keys into words", () => {
    expect(keyWords("shippingZipCode")).toBe("shipping zip code");
    expect(keyWords("first_name")).toBe("first name");
  });

  it("generates fictional, plausible values from the key", () => {
    expect(generateTestDataValue("email", { seed: "r1" })).toMatch(/^qa\.[a-z0-9]{6}@example\.com$/);
    expect(generateTestDataValue("customerEmail", { seed: "r1" })).toMatch(/@example\.com$/);
    expect(generateTestDataValue("firstName")).toBe("Alex");
    expect(generateTestDataValue("last_name")).toBe("Tester");
    expect(generateTestDataValue("fullName")).toBe("Alex Tester");
    expect(generateTestDataValue("phone")).toMatch(/^\+1 555 01\d\d$/);
    expect(generateTestDataValue("shippingZipCode")).toBe("12345");
    expect(generateTestDataValue("quantity")).toBe(1);
    expect(generateTestDataValue("cardExpiry")).toBe("12/34");
    expect(generateTestDataValue("cardNumber")).toBe("4242424242424242");
    expect(generateTestDataValue("searchTerm")).toBe("test");
    expect(generateTestDataValue("message")).toBe("This is an automated test message.");
    expect(generateTestDataValue("somethingElse", { seed: "s" })).toMatch(/^test-[a-z0-9]{6}$/);
  });

  it("is deterministic for a seed and varies across seeds", () => {
    expect(generateTestDataValue("email", { seed: "a" })).toBe(generateTestDataValue("email", { seed: "a" }));
    expect(generateTestDataValue("email", { seed: "a" })).not.toBe(generateTestDataValue("email", { seed: "b" }));
  });

  it("never generates a credential", () => {
    for (const key of ["password", "userPassword", "apiKey", "api_key", "accessToken", "pin", "cvc", "passcode"]) {
      expect(isCredentialKey(key)).toBe(true);
      expect(generateTestDataValue(key)).toBeNull();
    }
    expect(isCredentialKey("passengerName")).toBe(false);
  });
});
