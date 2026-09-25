import { describe, expect, it } from "vitest";
import { DESTRUCTIVE_TERMS, assertActionAllowed, type ActionPolicy } from "./action-policy";

const deny: ActionPolicy = { allowDestructive: false };
const allow: ActionPolicy = { allowDestructive: true };

describe("assertActionAllowed — default policy denies destructive actions", () => {
  it.each([
    ["Click the Delete button", "delete"],
    ["delete the item", "delete"],
    ["Remove account", "remove account"],
    ["close   account now", "close account"],
    ["Deactivate my profile", "deactivate"],
    ["Pay for the order", "pay"],
    ["Click PAY NOW", "pay now"],
    ["Place order", "place order"],
    ["place-order", "place order"],
    ["Purchase the item", "purchase"],
    ["Buy now", "buy now"],
    ["Transfer funds", "transfer"],
    ["Send money to Bob", "send money"],
    ["Unsubscribe from newsletter", "unsubscribe"],
    ["Cancel subscription", "cancel subscription"],
    ["Cancel plan", "cancel plan"],
    ["Click the Checkout submit button", "checkout"],
    ["submit checkout", "checkout"],
    ["Confirm checkout", "checkout"],
    ["Complete check-out", "checkout"],
  ])("%j → %s", (instruction, matched) => {
    expect(assertActionAllowed({ instruction }, deny)).toEqual({
      allowed: false,
      reason: "DESTRUCTIVE_ACTION_NOT_AUTHORIZED",
      matched,
    });
  });

  it("matches the element name even when the instruction is innocuous", () => {
    expect(
      assertActionAllowed({ instruction: "click the button", elementRole: "button", elementName: "Delete account" }, deny),
    ).toEqual({ allowed: false, reason: "DESTRUCTIVE_ACTION_NOT_AUTHORIZED", matched: "delete" });
  });

  it("matches the element text even when the instruction is innocuous", () => {
    expect(
      assertActionAllowed({ instruction: "click the primary button", elementText: "Place Order" }, deny),
    ).toMatchObject({ allowed: false, matched: "place order" });
  });

  it("checkout + submit semantics across instruction and element", () => {
    expect(
      assertActionAllowed({ instruction: "submit the form", elementRole: "button", elementName: "Checkout" }, deny),
    ).toMatchObject({ allowed: false, matched: "checkout" });
  });

  it("does not assemble multi-word terms across fields", () => {
    expect(assertActionAllowed({ instruction: "Cancel", elementName: "Plan details" }, deny)).toEqual({ allowed: true });
  });

  it("tolerates null/undefined element fields", () => {
    expect(
      assertActionAllowed({ instruction: "search", elementRole: null, elementName: null, elementText: null }, deny),
    ).toEqual({ allowed: true });
  });
});

describe("assertActionAllowed — default policy allows benign actions", () => {
  it.each([
    "add to cart",
    "Add to Cart",
    "search",
    "Search for red shoes",
    "open cart",
    "log in",
    "Log in with the test account",
    "open checkout page",
    "Proceed to checkout",
    "Go to the checkout",
    "Submit the search form",
    "Remove item from cart", // only "remove account" is destructive
    "Display payment options", // "pay" must be a whole word
    "Open PayPal info page",
    "View deleted items", // "deleted" is not "delete"
    "Close the modal",
    "Cancel", // plain cancel of a dialog
  ])("%j", (instruction) => {
    expect(assertActionAllowed({ instruction }, deny)).toEqual({ allowed: true });
  });

  it("allows a checkout button on its own (navigation, no submit semantics)", () => {
    expect(
      assertActionAllowed({ instruction: "click checkout", elementRole: "button", elementName: "Checkout" }, deny),
    ).toEqual({ allowed: true });
  });
});

describe("assertActionAllowed — allowDestructive = true", () => {
  it.each([
    "Delete account",
    "Pay now",
    "Place order",
    "Buy now",
    "submit checkout",
    "Transfer funds",
    "Cancel subscription",
  ])("allows %j", (instruction) => {
    expect(assertActionAllowed({ instruction, elementName: "Delete account" }, allow)).toEqual({ allowed: true });
  });
});

describe("DESTRUCTIVE_TERMS", () => {
  it("contains every term from the plan", () => {
    expect([...DESTRUCTIVE_TERMS].sort()).toEqual(
      [
        "delete",
        "remove account",
        "close account",
        "deactivate",
        "pay",
        "pay now",
        "place order",
        "purchase",
        "buy now",
        "checkout",
        "transfer",
        "send money",
        "unsubscribe",
        "cancel subscription",
        "cancel plan",
      ].sort(),
    );
  });

  it("every term (except conditional checkout) is denied on its own", () => {
    for (const term of DESTRUCTIVE_TERMS) {
      if (term === "checkout") continue;
      expect(assertActionAllowed({ instruction: term }, deny)).toMatchObject({ allowed: false, matched: term });
    }
  });
});
