import type { LocatorCandidate } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { candidatesFromDescription, LOCATOR_STRATEGY_ORDER, rankLocatorCandidates, type ElementDescription } from "./locator-policy";

const describeEl = (overrides: Partial<ElementDescription> = {}): ElementDescription => ({
  tag: "button",
  role: null,
  name: null,
  labels: [],
  placeholder: null,
  text: null,
  testId: null,
  id: null,
  nameAttr: null,
  xpath: "/html[1]/body[1]/button[1]",
  ...overrides,
});

const strategies = (cs: LocatorCandidate[]) => cs.map((c) => c.strategy);

describe("rankLocatorCandidates", () => {
  it("orders role → label → placeholder → text → testId → css → xpath whatever the input order", () => {
    const input: LocatorCandidate[] = [
      { strategy: "xpath", selector: "/html[1]/body[1]/input[1]" },
      { strategy: "css", selector: "#email" },
      { strategy: "testId", value: "email" },
      { strategy: "text", text: "Email", exact: true },
      { strategy: "placeholder", text: "you@example.com" },
      { strategy: "label", text: "Email" },
      { strategy: "role", role: "textbox", name: "Email", exact: true },
    ];
    expect(strategies(rankLocatorCandidates(input))).toEqual([...LOCATOR_STRATEGY_ORDER]);
  });

  it("is stable within a strategy and does not mutate its input", () => {
    const input: LocatorCandidate[] = [
      { strategy: "css", selector: "#a" },
      { strategy: "label", text: "First" },
      { strategy: "label", text: "Second" },
    ];
    const copy = structuredClone(input);
    expect(rankLocatorCandidates(input)).toEqual([
      { strategy: "label", text: "First" },
      { strategy: "label", text: "Second" },
      { strategy: "css", selector: "#a" },
    ]);
    expect(input).toEqual(copy);
  });

  it("drops duplicates and candidates with empty values", () => {
    const ranked = rankLocatorCandidates([
      { strategy: "testId", value: "buy" },
      { strategy: "testId", value: "buy" },
      { strategy: "label", text: "   " },
      { strategy: "role", role: "button", name: "", exact: true },
      { strategy: "text", text: "", exact: false },
      { strategy: "xpath", selector: "/html[1]/body[1]/button[1]" },
    ]);
    expect(ranked).toEqual([
      { strategy: "testId", value: "buy" },
      { strategy: "xpath", selector: "/html[1]/body[1]/button[1]" },
    ]);
  });
});

describe("candidatesFromDescription", () => {
  it("a button with role and accessible name: role first, then text, testId, css, xpath", () => {
    const cs = candidatesFromDescription(
      describeEl({ role: "button", name: "Add to cart", text: "Add to cart", testId: "add-to-cart", id: "add" }),
    );
    expect(cs).toEqual([
      { strategy: "role", role: "button", name: "Add to cart", exact: true },
      { strategy: "text", text: "Add to cart", exact: true },
      { strategy: "testId", value: "add-to-cart" },
      { strategy: "css", selector: "#add" },
      { strategy: "xpath", selector: "/html[1]/body[1]/button[1]" },
    ]);
  });

  it("form fields get label and placeholder candidates but never a text candidate", () => {
    const cs = candidatesFromDescription(
      describeEl({
        tag: "input",
        role: "textbox",
        name: "Email",
        labels: ["Email", "Email"],
        placeholder: "you@example.com",
        text: "ignored",
        nameAttr: "email",
        xpath: "/html[1]/body[1]/input[1]",
      }),
    );
    expect(cs).toEqual([
      { strategy: "role", role: "textbox", name: "Email", exact: true },
      { strategy: "label", text: "Email" },
      { strategy: "placeholder", text: "you@example.com" },
      { strategy: "css", selector: 'input[name="email"]' },
      { strategy: "xpath", selector: "/html[1]/body[1]/input[1]" },
    ]);
  });

  it("skips roles Playwright cannot target by name (generic, StaticText, none) and nameless roles", () => {
    expect(strategies(candidatesFromDescription(describeEl({ tag: "div", role: "generic", name: "x", testId: "t" })))).toEqual([
      "testId",
      "xpath",
    ]);
    expect(strategies(candidatesFromDescription(describeEl({ tag: "span", role: "StaticText", name: "x" })))).toEqual(["xpath"]);
    expect(strategies(candidatesFromDescription(describeEl({ role: "button", name: "" })))).toEqual(["xpath"]);
  });

  it("maps Chromium's 'image' role to Playwright's 'img'", () => {
    const [first] = candidatesFromDescription(describeEl({ tag: "img", role: "image", name: "Logo" }));
    expect(first).toEqual({ strategy: "role", role: "img", name: "Logo", exact: true });
  });

  it("omits text candidates for long or multi-line text", () => {
    const long = "x".repeat(81);
    expect(strategies(candidatesFromDescription(describeEl({ tag: "p", text: long })))).toEqual(["xpath"]);
    expect(strategies(candidatesFromDescription(describeEl({ tag: "p", text: "a\nb" })))).toEqual(["xpath"]);
  });

  it("escapes ids that are not plain CSS identifiers", () => {
    const cs = candidatesFromDescription(describeEl({ id: 'weird:id"1' }));
    expect(cs).toContainEqual({ strategy: "css", selector: '[id="weird:id\\"1"]' });
    expect(candidatesFromDescription(describeEl({ id: "1abc" }))).toContainEqual({ strategy: "css", selector: '[id="1abc"]' });
  });
});
