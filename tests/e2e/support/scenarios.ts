import { VALID_EMAIL } from "@platform/demo-shop";
import type { ExplorerScript } from "../scripted-explorer";

/**
 * CI-mode scenarios (Task 21): what the scripted model answers for each requirement. The step and
 * fact descriptions below are also the phrases DEMO_SHOP_SCRIPT resolves on the demo shop, so each
 * scenario runs the real executor, recorder, fact reader, verifier, compiler, rerun and
 * reconciliation against real pages.
 *
 * The requirement compiler's post-validation applies to these replies as to a real model's:
 * `sourceText` must quote the requirement verbatim, and an outcome may not assert a number the
 * requirement does not state (it would become an AI-judged `semantic` check) — hence "iPhone",
 * not "iPhone 17 Pro".
 */

export const REQUIREMENTS = {
  cart: "Verify that a user can search for an iPhone, add it to the cart, and see the selected product in the cart.",
  account: "Log in and verify the account page shows the user's email",
  deletion: "Verify that account deletion works",
  dangerZone: "Log in and verify that the button in the danger zone shows a confirmation",
  probe: "Verify that the egress probe page shows its heading",
} as const;

/**
 * What the scripted model suggests when a blank-requirement run surveys the demo shop (CI mode).
 * S-1's text differs from REQUIREMENTS.cart on purpose: platform-suggest.spec.ts edits it into that
 * requirement, which the cart scenario below answers.
 */
export const DEMO_SHOP_SUGGESTIONS = {
  suggestions: [
    {
      title: "Add an iPhone to the cart",
      requirement: "A user can search for an iPhone and add it to the cart.",
      why: "Every page has a product search, and product pages have an Add to cart button.",
      needs: { secrets: [], testData: [] },
      destructive: false,
    },
    {
      title: "Search the catalog",
      requirement: "Searching for Pixel on the products page lists only products whose names contain Pixel.",
      why: "The products page has a search form.",
      needs: { secrets: [], testData: [] },
      destructive: false,
    },
    {
      title: "Sign in to the account",
      requirement: REQUIREMENTS.account,
      why: "The header links to a login page.",
      needs: { secrets: ["password"], testData: ["email"] },
      destructive: false,
    },
  ],
};

const step = (kind: string, description: string, extra: Record<string, unknown> = {}) => ({
  kind,
  description,
  inputRef: null,
  checkpoint: null,
  criterionIds: [],
  destructive: false,
  ...extra,
});
const criterion = (sourceText: string, statement: string, expectedOutcome: Record<string, unknown>) => ({
  sourceText,
  statement,
  expectedOutcome,
  preconditions: [],
  ambiguity: null,
});

export interface Scenario {
  requirement: string;
  /** Requirement-compiler reply (criteria + facts). */
  compiled: { criteria: unknown[]; facts: unknown[] };
  /** Planner reply. */
  plan: { title: string; steps: unknown[]; stopConditions: string[] };
}

const loginSteps = [
  step("navigate", "Open the login page at /login"),
  step("fill", "Type the email into the email field", { inputRef: { source: "testData", key: "email" } }),
  step("fill", "Type the password into the password field", { inputRef: { source: "secret", key: "password" } }),
  step("login", "Click the log in button"),
];

export const SCENARIOS: Scenario[] = [
  {
    requirement: REQUIREMENTS.cart,
    compiled: {
      criteria: [
        criterion("add it to the cart", "The cart count increases after adding the product", {
          kind: "numeric_compare",
          left: { key: "cartCount", checkpoint: "after_add" },
          operator: "gt",
          right: { key: "cartCount", checkpoint: "before_add" },
        }),
        criterion("see the selected product in the cart", "The cart lists the iPhone", {
          kind: "collection_contains",
          collection: { key: "cartItems", checkpoint: "cart_page" },
          item: "iPhone",
          match: "contains",
        }),
      ],
      facts: [
        { key: "cartCount", checkpoint: "before_add", description: "The number on the cart badge", valueType: "number" },
        { key: "cartCount", checkpoint: "after_add", description: "The number on the cart badge", valueType: "number" },
        { key: "cartItems", checkpoint: "cart_page", description: "The products listed in the cart", valueType: "string_list" },
      ],
    },
    plan: {
      title: "Search, add to cart, open the cart",
      steps: [
        step("navigate", "Open the shop home page"),
        step("search", "Search for iPhone in the product search field", { inputRef: { source: "literal", key: "iPhone" } }),
        step("click", "Open the first search result", { criterionIds: ["AC-2"] }),
        step("capture_checkpoint", "Read the cart badge before adding", { checkpoint: "before_add" }),
        step("click", "Click the Add to cart button", { criterionIds: ["AC-1", "AC-2"] }),
        step("capture_checkpoint", "Read the cart badge after adding", { checkpoint: "after_add" }),
        step("navigate", "Open the cart page at /cart"),
        step("capture_checkpoint", "Read the cart contents", { checkpoint: "cart_page" }),
      ],
      stopConditions: [],
    },
  },
  {
    requirement: REQUIREMENTS.account,
    compiled: {
      criteria: [
        criterion("verify the account page shows the user's email", `The account page shows ${VALID_EMAIL}`, {
          kind: "text_matches",
          fact: { key: "accountEmail", checkpoint: "logged_in" },
          match: { mode: "contains", value: VALID_EMAIL, caseSensitive: false },
        }),
      ],
      facts: [{ key: "accountEmail", checkpoint: "logged_in", description: "The signed-in email on the account page", valueType: "string" }],
    },
    plan: {
      title: "Log in and read the account email",
      steps: [...loginSteps, step("capture_checkpoint", "Read the account page", { checkpoint: "logged_in", criterionIds: ["AC-1"] })],
      stopConditions: [],
    },
  },
  {
    requirement: REQUIREMENTS.deletion,
    compiled: {
      criteria: [
        criterion("Verify that account deletion works", "Deleting the account shows a confirmation", {
          kind: "text_matches",
          fact: { key: "flashMessage", checkpoint: "after_delete" },
          match: { mode: "contains", value: "Account deletion requested", caseSensitive: false },
        }),
      ],
      facts: [{ key: "flashMessage", checkpoint: "after_delete", description: "The confirmation message shown after deleting", valueType: "string" }],
    },
    plan: {
      title: "Log in and delete the account",
      steps: [
        ...loginSteps,
        step("click", "Click the Delete account button", { criterionIds: ["AC-1"], destructive: true }),
        step("capture_checkpoint", "Read the confirmation", { checkpoint: "after_delete", criterionIds: ["AC-1"] }),
      ],
      stopConditions: [],
    },
  },
  {
    // The click is neither flagged destructive nor worded with a destructive term, so the planner lets
    // it through; only the executor's check of the element it resolves to ("Delete account") stops it.
    // That check is what stands between a page's injected instructions and a destructive click.
    requirement: REQUIREMENTS.dangerZone,
    compiled: {
      criteria: [
        criterion("verify that the button in the danger zone shows a confirmation", "The danger zone button shows a confirmation", {
          kind: "text_matches",
          fact: { key: "flashMessage", checkpoint: "after_danger_zone" },
          match: { mode: "contains", value: "Account deletion requested", caseSensitive: false },
        }),
      ],
      facts: [
        { key: "flashMessage", checkpoint: "after_danger_zone", description: "The confirmation message shown after clicking", valueType: "string" },
      ],
    },
    plan: {
      title: "Log in and press the button in the danger zone",
      steps: [
        ...loginSteps,
        step("click", "Click the button in the danger zone", { criterionIds: ["AC-1"] }),
        step("capture_checkpoint", "Read the confirmation", { checkpoint: "after_danger_zone", criterionIds: ["AC-1"] }),
      ],
      stopConditions: [],
    },
  },
  {
    requirement: REQUIREMENTS.probe,
    compiled: {
      criteria: [
        criterion("the egress probe page shows its heading", "The page heading reads Egress probe", {
          kind: "text_matches",
          fact: { key: "pageHeading", checkpoint: "probe_page" },
          match: { mode: "contains", value: "Egress probe", caseSensitive: false },
        }),
      ],
      facts: [{ key: "pageHeading", checkpoint: "probe_page", description: "The main heading of the page", valueType: "string" }],
    },
    plan: {
      title: "Open the probe page",
      steps: [step("navigate", "Open the probe page"), step("capture_checkpoint", "Read the heading", { checkpoint: "probe_page", criterionIds: ["AC-1"] })],
      stopConditions: [],
    },
  },
];

/** Where the demo shop shows what the scenarios' descriptions name (first matching rule wins). */
export const DEMO_SHOP_SCRIPT: ExplorerScript = {
  rules: [
    // The executor's search-submit instruction repeats the step description: match it first.
    { when: "submits this search", selectors: ['form[role="search"] button[type="submit"]'] },
    { when: "product search field", selectors: ['[data-testid="search-input"]'] },
    { when: "first search result", selectors: ['ul[aria-label="Product results"] > li:first-child a'] },
    { when: "add to cart button", selectors: ['[data-testid="add-to-cart"]'] },
    { when: "email field", selectors: ["#email"] },
    { when: "password field", selectors: ["#password"] },
    { when: "log in button", selectors: ['form[aria-label="Log in"] button[type="submit"]'] },
    { when: "delete account button", selectors: ['[data-testid="delete-account"]'] },
    { when: "button in the danger zone", selectors: ['[data-testid="delete-account"]'] },
    { when: "number on the cart badge", selectors: ['[data-testid="cart-count"]'], fact: { key: "cartCount", mode: "number" } },
    // An empty cart (?bug=empty_cart) shows a message instead of the list: that is what the cart lists.
    {
      when: "products listed in the cart",
      selectors: ['ul[aria-label="Cart items list"]', '[data-testid="cart-empty"]'],
      fact: { key: "cartItems", mode: "text_list" },
    },
    { when: "signed-in email", selectors: ['[data-testid="account-email"]'], fact: { key: "accountEmail", mode: "text" } },
    { when: "confirmation message", selectors: ['[data-testid="flash"]'], fact: { key: "flashMessage", mode: "text" } },
    { when: "main heading", selectors: ["main h1"], fact: { key: "pageHeading", mode: "text" } },
  ],
};
