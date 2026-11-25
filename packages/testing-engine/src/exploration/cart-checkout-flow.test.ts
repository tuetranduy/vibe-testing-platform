import type { AcceptanceCriterion, NormalizedRequirement, TestPlan } from "@platform/contracts";
import type { ExplorerSession } from "@platform/stagehand-adapter/browser-explorer";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compilePlaywrightTest } from "../compiler/test-compiler";
import type { StageContext } from "../orchestrator/stages";
import { reconcile } from "../reconciliation/reconcile";
import { verifyCriterion } from "../verification/verifier";
import { runExploration } from "./executor";

/**
 * run_0mw3iqd89b1e9265a528ed663 (frontends-demo.vercel.app, "Add ADELAIDE 2 to cart … verify checkout page is displayed")
 * ended INCONCLUSIVE on all four criteria although the flow works. The site, reduced to what mattered:
 * - the cart button shows no badge while the cart is empty (KI-060);
 * - Add to cart posts a fetch, then shows the count and a `role="alert"` toast for a few seconds; the requirement names
 *   the popup without quoting its text (KI-059);
 * - the drawer's Checkout link first loads the route's script, then fetches, then changes the URL (KI-058).
 * The model is slow (each call outlives the toast) and reads the page as it was when the call began.
 * run_0mw4iqx0g3b597375de25c6e0 used numeric_compare for the same empty-cart increase, so both forms must pass.
 */

const TARGET = "http://frontends.test/";
const PRODUCTS = `<header><button data-testid="cart" aria-label="Mini cart"><span class="sr-only">items in cart, view bag</span></button></header>
<main><h2>ADELAIDE 2</h2><button id="add">Add to cart</button><aside id="drawer" hidden><a id="checkout" href="/checkout">Checkout</a></aside></main>
<div id="toasts"></div>
<script>
  document.getElementById("add").onclick = () => fetch("/add").then(() => {
    const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = "1";
    document.querySelector("[data-testid=cart]").prepend(badge);
    document.getElementById("toasts").innerHTML = '<div role="alert" id="toast"><div class="message">ADELAIDE 2 has been added to cart.</div><button><span>Close</span></button></div>';
    setTimeout(() => document.getElementById("toast")?.remove(), 800);
  });
  document.querySelector("[data-testid=cart]").onclick = () => { document.getElementById("drawer").hidden = false; };
  document.getElementById("checkout").onclick = (e) => {
    e.preventDefault();
    const s = document.createElement("script"); s.src = "/route-checkout.js"; document.head.append(s);
  };
</script>`;
const CHECKOUT_CHUNK = `fetch("/context").then(() => {
  history.pushState({}, "", "/checkout");
  document.querySelector("main").innerHTML = "<h3>Personal Information</h3>";
});`;

const outcome = (key: string, checkpoint: string) => ({ key, checkpoint });
const ac = (id: string, sourceText: string, statement: string, expectedOutcome: AcceptanceCriterion["expectedOutcome"]): AcceptanceCriterion =>
  ({ id, sourceText, statement, expectedOutcome, preconditions: [], critical: true, ambiguity: null });

const criteria: AcceptanceCriterion[] = [
  ac("AC-1", "Verify ADELAIDE 2 has been added to cart. popup displayed", "After adding ADELAIDE 2, a confirmation popup is displayed.",
    { kind: "visible", fact: outcome("popupVisible", "after_add"), expected: true }),
  ac("AC-2", "Verify ADELAIDE 2 has been added to cart", "The confirmation popup shows that ADELAIDE 2 was the product added to the cart.",
    { kind: "text_matches", fact: outcome("popupText", "after_add"), match: { mode: "contains", value: "ADELAIDE 2", caseSensitive: false } }),
  ac("AC-3", "Verify cart quantity increased by 1", "The cart quantity after adding ADELAIDE 2 is exactly one more than before.",
    { kind: "numeric_delta", before: outcome("cartQuantity", "before_add"), after: outcome("cartQuantity", "after_add"), delta: 1 }),
  ac("AC-4", "verify checkout page is displayed", "The checkout page is displayed after clicking checkout from the cart.",
    { kind: "visible", fact: outcome("checkoutPageVisible", "checkout_page"), expected: true }),
];
const requirement: NormalizedRequirement = {
  runId: "run_cart", revision: 1, confirmedAt: new Date().toISOString(), criteria,
  originalText: "Add ADELAIDE 2 to cart\nVerify ADELAIDE 2 has been added to cart. popup displayed\nVerify cart quantity increased by 1\nclick on cart\nclick checkout\nverify checkout page is displayed",
  facts: [
    { key: "popupVisible", valueType: "boolean", checkpoint: "after_add", description: "Whether a confirmation popup is shown right after clicking Add to cart for ADELAIDE 2" },
    { key: "popupText", valueType: "string", checkpoint: "after_add", description: "Text content of the confirmation popup shown right after adding ADELAIDE 2 to the cart" },
    { key: "cartQuantity", valueType: "number", checkpoint: "before_add", description: "Number of items shown in the cart indicator before adding ADELAIDE 2" },
    { key: "cartQuantity", valueType: "number", checkpoint: "after_add", description: "Number of items shown in the cart indicator right after adding ADELAIDE 2" },
    { key: "checkoutPageVisible", valueType: "boolean", checkpoint: "checkout_page", description: "Whether the checkout page (with checkout form or order summary) is displayed after clicking checkout" },
  ],
};
const ids = criteria.map((c) => c.id);
const ps = (id: string, kind: TestPlan["scenarios"][number]["steps"][number]["kind"], description: string, checkpoint?: string) =>
  ({ id, kind, description, criterionIds: ids, destructive: false, ...(checkpoint ? { checkpoint } : {}) });
const plan: TestPlan = { runId: "run_cart", requirementRevision: 1, blockedCriteria: [], stopConditions: [], scenarios: [{
  id: "SC-1", title: "Add ADELAIDE 2 and check out", criterionIds: ids, steps: [
    ps("PS-1", "navigate", "Open the store."),
    ps("PS-3", "capture_checkpoint", "Record the cart quantity before adding.", "before_add"),
    ps("PS-4", "click", "Click the Add to cart button on the product card for ADELAIDE 2."),
    ps("PS-5", "wait_for", "Wait for the confirmation popup to be visible after adding ADELAIDE 2 to the cart."),
    ps("PS-6", "capture_checkpoint", "Record the popup and the cart quantity.", "after_add"),
    ps("PS-7", "click", "Click the cart indicator button labeled 'items in cart, view bag'."),
    ps("PS-8", "click", "Click the Checkout button on the cart page."),
    ps("PS-9", "capture_checkpoint", "Record whether the checkout page is displayed.", "checkout_page"),
  ],
}] };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SLOW_MODEL_MS = 1_000;

let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); });
afterAll(async () => { await browser?.close(); });

describe("frontends-demo cart → checkout (KI-058, KI-059, KI-060)", () => {
  it.each(["numeric_delta", "numeric_compare"] as const)("passes every criterion from DOM evidence and compiles them all (%s)", async (countRule) => {
    const runCriteria = criteria.map((c) => c.id === "AC-3" && countRule === "numeric_compare"
      ? { ...c, expectedOutcome: { kind: "numeric_compare" as const, left: outcome("cartQuantity", "after_add"), operator: "gt" as const, right: outcome("cartQuantity", "before_add") } }
      : c);
    const runRequirement = { ...requirement, criteria: runCriteria };
    await page.route(`${TARGET}**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/add" || url.pathname === "/context") {
        await sleep(150);
        return route.fulfill({ contentType: "application/json", body: "{}" });
      }
      if (url.pathname === "/route-checkout.js") {
        await sleep(250);
        return route.fulfill({ contentType: "text/javascript", body: CHECKOUT_CHUNK });
      }
      return route.fulfill({ contentType: "text/html", body: PRODUCTS });
    });

    const locate: [RegExp, string | null][] = [
      [/^Wait for the confirmation popup/, null],
      [/Add to cart button/, "#add"],
      [/before adding/, "[data-testid=cart] .sr-only"],
      [/right after adding/, ".badge"],
      [/popup/, null],
      [/cart indicator button/, "[data-testid=cart]"],
      [/Checkout button/, "#checkout"],
      [/checkout page/, "h3"],
    ];
    const session: ExplorerSession = {
      page,
      navigate: async (url) => { await page.goto(url); return { url: page.url() }; },
      observe: async (instruction) => {
        const selector = locate.find(([re]) => re.test(instruction))?.[1] ?? null;
        await sleep(SLOW_MODEL_MS / 4);
        if (!selector || (await page.locator(selector).count()) !== 1) return { elements: [], llm: null };
        return { elements: [{ selector, description: instruction, method: "click", arguments: [] }], llm: null };
      },
      act: async () => { throw new Error("Only replay an observed action"); },
      actOn: async (element) => { await page.locator(element.selector).click(); return { success: true, message: "clicked", element, navigationBlocks: [], llm: null }; },
      extract: async (instruction, schema) => {
        // The model sees the page as it is when the call begins, and answers long after.
        const seen = await page.evaluate(() => ({
          path: location.pathname,
          toast: document.querySelector("[role=alert]")?.textContent ?? null,
          badge: document.querySelector(".badge")?.textContent ?? null,
        }));
        await sleep(SLOW_MODEL_MS);
        const all: Record<string, unknown> = {
          popupVisible: seen.toast !== null,
          popupText: seen.toast,
          cartQuantity: seen.badge === null ? null : Number(seen.badge),
          checkoutPageVisible: seen.path === "/checkout",
        };
        const asked = Object.fromEntries([...instruction.matchAll(/^- (\w+):/gm)].map((m) => [m[1]!, all[m[1]!] ?? null]));
        return { data: schema.parse(asked), llm: null };
      },
      screenshot: () => page.screenshot(), close: async () => {},
    };
    const signal = new AbortController().signal;
    const ctx: StageContext = { runId: "run_cart", tenantId: "t_default", signal, deadlineAt: null,
      request: { targetUrl: TARGET, requirement: requirement.originalText, browser: "chromium", environment: "staging", testData: {}, secretNames: [],
        options: { maxRunSeconds: 120, maxExplorationSteps: 40, generatePlaywright: true, rerunGeneratedTest: false, autoConfirmCriteria: true, allowDestructiveActions: true, additionalAllowedHosts: [] } },
      budgets: { explorationMs: 120_000, rerunMs: 30_000 }, secrets: { names: [], get: () => undefined }, redact: (v) => v,
      publish: async () => {}, addCleanup: () => {}, boundary: async () => {}, budgetSignal: () => signal, now: () => new Date(), llm: null,
    };
    let artifacts = 0;
    const out = await runExploration(ctx, { plan, requirement: runRequirement, session, budget: signal }, { pollIntervalMs: 50, store: {
      saveFact: async () => {}, saveStep: async () => {}, saveScreenshot: async () => ({ artifactId: `art_${++artifacts}` }),
    } });

    expect(out.stopReason).toBe("COMPLETED");
    const provisional = runCriteria.map((criterion) => verifyCriterion({ criterion, facts: out.facts, steps: out.steps, blocked: [], stopReason: out.stopReason, plan }));
    const results = provisional.map((p) => reconcile(p, "UNAVAILABLE", out.facts, { evidenceArtifactIds: [], relatedStepIds: [], aiNote: null }));
    expect(results.map((r) => [r.criterionId, r.status, r.verdictSource, r.actual])).toEqual([
      ["AC-1", "PASS", "EXPLORATION_ONLY", "Popup visible after add is visible"],
      ["AC-2", "PASS", "EXPLORATION_ONLY", 'Popup text after add is "ADELAIDE 2 has been added to cart."'],
      ["AC-3", "PASS", "EXPLORATION_ONLY", countRule === "numeric_delta"
        ? "Cart quantity after add (1) - before add (0, no number shown) = +1"
        : "Cart quantity after add (1) > before add (0, no number shown)"],
      ["AC-4", "PASS", "EXPLORATION_ONLY", "Checkout page visible checkout page is visible"],
    ]);
    const compiled = compilePlaywrightTest({ requirement: runRequirement, plan, provisional, steps: out.steps, facts: out.facts, targetUrl: TARGET, secretNames: [], testData: {} });
    expect(compiled.compiledCriteria).toEqual(ids);
  }, 60_000);
});

describe("saved-address checkout on a single URL", () => {
  it.each([false, true])("preserves the checkout state and required address edits (explicit address: %s)", async (explicitAddress) => {
    const target = "http://checkout.test/";
    let orders = 0;
    await page.unroute(`${target}**`);
    await page.route(`${target}**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/order") {
        expect(route.request().method()).toBe("POST");
        orders++;
        return route.fulfill({ status: 204 });
      }
      if (path === "/receipt") return route.fulfill({ contentType: "text/html", body: "<h1>Order complete</h1>" });
      return route.fulfill({ contentType: "text/html", body: `<button onclick="location.href='/cart'">Continue</button>
        <ol>
          <li><h2>1 Shipping Address</h2><div class="step" id="shipping">
            <label>Shipping address <select><option value="42">Jane Doe, 12 Example Street, Testville</option><option value="">New Address</option></select></label>
            <label><input type="checkbox">In-Store Pickup</label>
            <a href="/cart">Back</a><input type="button" value="Continue" onclick="this.closest('.step').hidden=true; document.getElementById('methods').hidden=false">
          </div></li>
          <li><h2>2 Shipping Method</h2><div class="step" id="methods" hidden>
            <label><input type="radio" checked>Ground</label><input type="button" value="Continue" onclick="this.closest('.step').hidden=true; document.getElementById('confirm').hidden=false">
          </div></li>
          <li><h2>3 Confirm Order</h2><div class="step" id="confirm" hidden>
            <button onclick="fetch('/order',{method:'POST'}).then(() => location.href='/receipt')">Confirm order</button>
          </div></li>
        </ol>` });
    });

    const receipt = ac("AC-1", "Verify the order completed", "The order completes successfully.",
      { kind: "visible", fact: outcome("receipt", "after_order"), expected: true });
    const runRequirement = { ...requirement, originalText: explicitAddress ? "Use a different shipping address and place an order." : "Check out and place an order.\n- fill billing address section\n- fill shipping address section",
      criteria: [receipt], facts: [{ key: "receipt", checkpoint: "after_order", description: 'Whether the "Order complete" heading is visible', valueType: "boolean" as const }] };
    const scenarioSteps = [
      ps("PS-1", "navigate", "Open the target URL"),
      ps("PS-2", "wait_for", "Wait for the Shipping Method section to open."),
      ps("PS-3", "wait_for", "Wait for the Shipping address section of the checkout to open."),
      ps("PS-4", "click", "Uncheck the 'Ship to same address' checkbox in the Shipping Address section."),
      { ...ps("PS-5", "fill", "Fill the shipping street address"), inputRef: { source: "testData" as const, key: "streetAddress" } },
      ps("PS-6", "click", "Click the 'Continue' button in the Shipping Address section."),
      ps("PS-7", "wait_for", "Wait for the Shipping Method section to open."),
      ps("PS-8", "click", "Click the 'Continue' button in the Shipping Method section."),
      { ...ps("PS-9", "click", "Click the 'Confirm order' button"), destructive: true },
      ps("PS-10", "capture_checkpoint", "Verify the receipt", "after_order"),
    ].map((step) => ({ ...step, criterionIds: [receipt.id] }));
    const runPlan: TestPlan = { ...plan, scenarios: [{ ...plan.scenarios[0]!, steps: scenarioSteps, criterionIds: [receipt.id] }] };
    const signal = new AbortController().signal;
    const ctx: StageContext = { runId: "run_cart", tenantId: "t_default", signal, deadlineAt: null,
      request: { targetUrl: target, requirement: runRequirement.originalText, browser: "chromium", environment: "staging", testData: { streetAddress: "12 Example Street" }, secretNames: [],
        options: { maxRunSeconds: 120, maxExplorationSteps: 40, generatePlaywright: true, rerunGeneratedTest: false, autoConfirmCriteria: true, allowDestructiveActions: true, additionalAllowedHosts: [] } },
      budgets: { explorationMs: 120_000, rerunMs: 30_000 }, secrets: { names: [], get: () => undefined }, redact: (v) => v,
      publish: async () => {}, addCleanup: () => {}, boundary: async () => {}, budgetSignal: () => signal, now: () => new Date(), llm: null,
    };
    const observed: string[] = [];
    const navigated: string[] = [];
    const session: ExplorerSession = {
      page,
      navigate: async (url) => { navigated.push(url); await page.goto(url); return { url: page.url() }; },
      observe: async (instruction) => {
        observed.push(instruction);
        const elements = instruction.startsWith('Find the element that shows: Whether the "Order complete"')
          ? [{ selector: "h1", description: "Order receipt heading", method: "click", arguments: [] }] : [];
        return { elements, llm: null };
      },
      act: async () => { throw new Error("Only replay an observed action"); },
      actOn: async (element) => { await page.locator(element.selector).click(); return { success: true, message: "clicked", element, navigationBlocks: [], llm: null }; },
      extract: async (_instruction, schema) => ({ data: schema.parse({ receipt: true }), llm: null }),
      screenshot: () => page.screenshot(), close: async () => {},
    };
    let artifacts = 0;
    let replans = 0;
    let routeRecoveries = 0;
    const out = await runExploration(ctx, { plan: runPlan, requirement: runRequirement, session, budget: signal, seenUrls: [target] }, {
      pollIntervalMs: 10, actionQuietMs: 20,
      replanner: { async replan() { replans++; return { steps: null, reason: "model_failed" }; } },
      findRoutes: async () => { routeRecoveries++; return []; },
      store: { saveFact: async () => {}, saveStep: async () => {}, saveScreenshot: async () => ({ artifactId: `art_${++artifacts}` }) },
    });

    expect(navigated).toEqual([target]);
    expect(routeRecoveries).toBe(0);
    expect(out.steps.find((step) => step.plannedStepId === "PS-2")?.outcome).toBe("FAILED");
    expect(out.steps.find((step) => step.plannedStepId === "PS-3")?.outcome).toBe("SUCCESS");
    if (explicitAddress) {
      expect(out.revisedPlan).toBeUndefined();
      expect(replans).toBe(1);
      expect(observed).toEqual([scenarioSteps[3]!.description]);
      expect(orders).toBe(0);
      expect(page.url()).toBe(target);
    } else {
      expect(replans, JSON.stringify(out.steps.map(({ plannedStepId, kind, outcome, error }) => ({ plannedStepId, kind, outcome, error })))).toBe(0);
      expect(observed).toEqual([expect.stringContaining('Find the element that shows: Whether the "Order complete"')]);
      expect(out.revisedPlan?.scenarios[0]!.steps.map(({ id }) => id)).toEqual(["PS-1", "PS-2", "PS-3", "PS-6", "PS-7", "PS-8", "PS-9", "PS-10"]);
      expect(out.steps.filter((step) => step.kind === "act" && step.onGoldenPath).map((step) => step.plannedStepId)).toEqual(["PS-6", "PS-8", "PS-9"]);
      for (const [plannedStepId, scope] of [["PS-6", "css=#shipping"], ["PS-8", "css=#methods"]]) {
        const ref = out.steps.find((step) => step.kind === "act" && step.plannedStepId === plannedStepId)?.element;
        expect(ref?.candidates[ref.chosenIndex]).toMatchObject({ strategy: "role", name: "Continue", scope });
      }
      expect(orders).toBe(1);
      expect(page.url()).toBe(`${target}receipt`);
      expect(verifyCriterion({ criterion: receipt, facts: out.facts, steps: out.steps, blocked: [], stopReason: out.stopReason, plan: runPlan }).status).toBe("PASS");
    }
  }, 30_000);
});
