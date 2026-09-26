import { ObservedFactSchema, type ElementRef } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { factFromReadings, factValuesEqual, modeForValueType, parseNumber, urlFact } from "./fact-reader";

const element: ElementRef = {
  candidates: [{ strategy: "testId", value: "cart-count" }],
  chosenIndex: 0,
  framePath: [],
};

describe("parseNumber", () => {
  it.each([
    ["Cart (3)", 3],
    ["3", 3],
    ["-2 items", -2],
    ["CHF 1,299.50", 1299.5],
    ["CHF 1'299.00", 1299],
    ["1.234,56 €", 1234.56],
    ["12,5 kg", 12.5],
    ["Total: 1,000", 1000],
    ["Items: 4 of 10", 4],
  ])("%s → %s", (text, expected) => {
    expect(parseNumber(text)).toBe(expected);
  });

  it("returns null when there is no number", () => {
    expect(parseNumber("Your cart is empty")).toBeNull();
    expect(parseNumber("")).toBeNull();
  });
});

describe("factValuesEqual (model value vs DOM value, normalized)", () => {
  it("numbers: a numeric model string equals the DOM number", () => {
    expect(factValuesEqual("3", 3)).toBe(true);
    expect(factValuesEqual(3, 3)).toBe(true);
    expect(factValuesEqual("Cart (3)", 3)).toBe(true);
    expect(factValuesEqual(2, 3)).toBe(false);
    expect(factValuesEqual("two", 3)).toBe(false);
  });

  it("strings: case, surrounding and repeated whitespace are ignored", () => {
    expect(factValuesEqual("  Added   to CART ", "Added to cart")).toBe(true);
    expect(factValuesEqual("Added", "Added to cart")).toBe(false);
    expect(factValuesEqual(3, "3")).toBe(true);
  });

  it("booleans: true/false and yes/no strings", () => {
    expect(factValuesEqual(true, true)).toBe(true);
    expect(factValuesEqual("yes", true)).toBe(true);
    expect(factValuesEqual("false", false)).toBe(true);
    expect(factValuesEqual(true, false)).toBe(false);
  });

  it("lists: same length and order, items normalized", () => {
    expect(factValuesEqual(["iPhone 17 Pro ", "usb-c cable"], ["iPhone 17 Pro", "USB-C Cable"])).toBe(true);
    expect(factValuesEqual(["a"], ["a", "b"])).toBe(false);
    expect(factValuesEqual(["b", "a"], ["a", "b"])).toBe(false);
    expect(factValuesEqual("a", ["a"])).toBe(false);
  });

  it("null equals only null", () => {
    expect(factValuesEqual(null, null)).toBe(true);
    expect(factValuesEqual(null, "")).toBe(false);
    expect(factValuesEqual(0, null)).toBe(false);
  });
});

describe("modeForValueType", () => {
  it("maps requested value types to DOM read modes", () => {
    expect(modeForValueType("number")).toBe("number");
    expect(modeForValueType("string")).toBe("text");
    expect(modeForValueType("boolean")).toBe("visible");
    expect(modeForValueType("string_list")).toBe("text_list");
  });
});

describe("factFromReadings (provenance rules)", () => {
  const base = { key: "cartCount", checkpoint: "after_add", stepId: "step-3" };

  it("DOM value equals the model value (normalized) → DOM_VERIFIED with the DOM value, model value kept", () => {
    const fact = factFromReadings({ ...base, modelValue: "1", dom: { value: 1, read: { element, mode: "number" } } });
    expect(fact).toEqual({
      ...base,
      value: 1,
      provenance: "DOM_VERIFIED",
      read: { element, mode: "number" },
      modelValue: "1",
    });
    expect(ObservedFactSchema.parse(fact)).toEqual(fact);
  });

  it("DOM value differs → MODEL_EXTRACTED with both values kept", () => {
    const fact = factFromReadings({ ...base, modelValue: 2, dom: { value: 1, read: { element, mode: "number" } } });
    expect(fact).toEqual({
      ...base,
      value: 2,
      provenance: "MODEL_EXTRACTED",
      read: { element, mode: "number" },
      modelValue: 2,
      domValue: 1,
    });
    expect(ObservedFactSchema.parse(fact)).toEqual(fact);
  });

  it("no locatable element → MODEL_EXTRACTED without a read", () => {
    const fact = factFromReadings({ ...base, modelValue: 2, dom: null });
    expect(fact).toEqual({ ...base, value: 2, provenance: "MODEL_EXTRACTED", read: null, modelValue: 2 });
    expect(ObservedFactSchema.parse(fact)).toEqual(fact);
  });

  it("the reserved url key can never be model-sourced", () => {
    expect(() => factFromReadings({ ...base, key: "url", modelValue: "https://x", dom: null })).toThrow(/reserved/);
  });
});

describe("urlFact", () => {
  it("is always DOM_VERIFIED, read from the page itself", () => {
    const fact = urlFact({ url: () => "http://shop.test/cart" }, { checkpoint: "cart_page", stepId: "step-9" });
    expect(fact).toEqual({
      key: "url",
      checkpoint: "cart_page",
      value: "http://shop.test/cart",
      provenance: "DOM_VERIFIED",
      read: null,
      stepId: "step-9",
    });
    expect(ObservedFactSchema.parse(fact)).toEqual(fact);
  });
});
