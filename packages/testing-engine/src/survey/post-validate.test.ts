import { describe, expect, it } from "vitest";
import type { SurveyOutput } from "./model-output";
import { postValidateSuggestions } from "./post-validate";

type Raw = SurveyOutput["suggestions"][number];
const raw = (patch: Partial<Raw> = {}): Raw => ({
  title: "Add a product to the cart",
  requirement: "A user can add iPhone 17 Pro to the cart from its product page.",
  why: "Product pages have an Add to cart button.",
  needs: { secrets: [], testData: [] },
  destructive: false,
  ...patch,
});
const search = raw({ title: "Search", requirement: "Searching for Pixel lists only products whose names contain Pixel." });
const signIn = raw({
  title: "Sign in",
  requirement: "A user can sign in on the login page and sees their account page.",
  needs: { secrets: ["password"], testData: ["email"] },
});

describe("postValidateSuggestions", () => {
  it("numbers the valid suggestions S-1… in order and trims their texts", () => {
    const r = postValidateSuggestions({ suggestions: [raw({ title: "  Add a product to the cart  " }), search, signIn] });
    expect(r.issues).toEqual([]);
    expect(r.suggestions.map((s) => [s.id, s.title])).toEqual([
      ["S-1", "Add a product to the cart"],
      ["S-2", "Search"],
      ["S-3", "Sign in"],
    ]);
    expect(r.suggestions[2]!.needs).toEqual({ secrets: ["password"], testData: ["email"] });
  });

  it("drops an exact duplicate without asking again", () => {
    const r = postValidateSuggestions({ suggestions: [raw(), search, raw({ title: "Same test" }), signIn] });
    expect(r.issues).toEqual([]);
    expect(r.suggestions.map((s) => s.title)).toEqual(["Add a product to the cart", "Search", "Sign in"]);
  });

  it("reports a title, requirement or why outside its limits, per suggestion, and keeps the others", () => {
    const r = postValidateSuggestions({
      suggestions: [raw({ title: "ab" }), search, raw({ requirement: "too short" }), signIn, raw({ title: "Long why", why: "w".repeat(301) })],
    });
    expect(r.issues).toEqual([
      expect.stringMatching(/^suggestions\.0\.title: /),
      expect.stringMatching(/^suggestions\.2\.requirement: /),
      expect.stringMatching(/^suggestions\.4\.why: /),
      expect.stringMatching(/at least 3/),
    ]);
    expect(r.suggestions.map((s) => s.title)).toEqual(["Search", "Sign in"]);
  });

  it("reports needs that are not a secret name or a test data key", () => {
    const r = postValidateSuggestions({ suggestions: [raw({ needs: { secrets: ["Password"], testData: ["e-mail"] } }), search, signIn] });
    expect(r.issues).toEqual(
      expect.arrayContaining([expect.stringMatching(/^suggestions\.0\.needs\.secrets\.0: /), expect.stringMatching(/^suggestions\.0\.needs\.testData\.0: /)]),
    );
  });

  it("marks a suggestion destructive when its text has a destructive term, even when the model did not", () => {
    const r = postValidateSuggestions({
      suggestions: [raw({ title: "Delete the account", requirement: "A signed-in user can delete their account from the account page." }), search, signIn],
    });
    expect(r.suggestions[0]!.destructive).toBe(true);
    expect(r.suggestions[1]!.destructive).toBe(false);
  });

  it("keeps the model's destructive flag", () => {
    expect(postValidateSuggestions({ suggestions: [raw({ destructive: true }), search, signIn] }).suggestions[0]!.destructive).toBe(true);
  });

  it("asks for more when fewer than 3 are usable, and for fewer past 8 (keeping the first 8)", () => {
    expect(postValidateSuggestions({ suggestions: [raw(), search] }).issues).toEqual([expect.stringMatching(/at least 3/)]);
    const ten = Array.from({ length: 10 }, (_, i) => raw({ title: `Test ${i + 1}`, requirement: `A visitor can open page ${i + 1} and sees its heading.` }));
    const r = postValidateSuggestions({ suggestions: ten });
    expect(r.issues).toEqual([expect.stringMatching(/at most 8/)]);
    expect(r.suggestions.map((s) => s.id)).toEqual(["S-1", "S-2", "S-3", "S-4", "S-5", "S-6", "S-7", "S-8"]);
  });
});
