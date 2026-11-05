import type { AcceptanceCriterion, FactRequest, NormalizedRequirement, TestPlan } from "@platform/contracts";
import type { ExplorerSession } from "@platform/stagehand-adapter/browser-explorer";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureEarlyNotificationFact } from "./early-facts";
import { runExploration } from "./executor";
import type { StageContext } from "../orchestrator/stages";
import { verifyCriterion } from "../verification/verifier";
import { reconcile } from "../reconciliation/reconcile";
import { compilePlaywrightTest } from "../compiler/test-compiler";

const request: FactRequest = { key: "popup", checkpoint: "after_add", valueType: "boolean", description: 'Whether a popup reading "Item added to cart" is shown' };
const criteria: AcceptanceCriterion[] = [{ id: "AC-1", sourceText: request.description, statement: request.description,
  expectedOutcome: { kind: "visible", fact: { key: "popup", checkpoint: "after_add" }, expected: true },
  preconditions: [], critical: true, ambiguity: null }];
let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); });
afterAll(async () => { await browser?.close(); });

describe("early notification evidence", () => {
  it("keeps a DOM reading of a notification after it disappears", async () => {
    await page.setContent('<div role="status"><span id="toast">Item added to cart</span></div>');
    const fact = await captureEarlyNotificationFact(page, request, criteria, "step_cp");
    await page.locator("#toast").evaluate((el) => el.remove());
    expect(fact).toMatchObject({ value: true, provenance: "DOM_VERIFIED", stepId: "step_cp", read: { mode: "visible" } });
    expect(fact).not.toHaveProperty("modelValue");
  });

  it.each([
    '<p>Item added to cart</p>',
    '<div role="status" hidden>Item added to cart</div>',
    '<div role="status">Other item added</div>',
    '<div role="status">Item added to cart</div><div role="alert">Item added to cart</div>',
  ])("does not guess a fact from unrelated, hidden or ambiguous text: %s", async (html) => {
    await page.setContent(html);
    expect(await captureEarlyNotificationFact(page, request, criteria, "step_cp")).toBeNull();
  });

  it("requires a literal subject and a confirmed visibility check", async () => {
    await page.setContent('<div role="status">Item added to cart</div>');
    const vague = [{ ...criteria[0]!, sourceText: "A popup should be displayed", statement: "A popup is displayed" }];
    expect(await captureEarlyNotificationFact(page, { ...request, description: "Whether a popup is shown" }, vague, "step_cp")).toBeNull();
    expect(await captureEarlyNotificationFact(page, request, [], "step_cp")).toBeNull();
  });

  it("uses the original unquoted notification text when the model paraphrases its description", async () => {
    await page.setContent('<div role="status">Item added to cart</div>');
    const paraphrased = { ...request, description: "Whether a popup stating the item was added to the cart is visible after clicking Add to cart" };
    const confirmed = [{ ...criteria[0]!, sourceText: "popup Item added to cart should be displayed",
      statement: "After clicking add to cart, a popup confirming that the item was added to the cart is shown." }];
    expect(await captureEarlyNotificationFact(page, paraphrased, confirmed, "step_cp")).toMatchObject({ value: true, provenance: "DOM_VERIFIED" });
  });

  it("waits briefly for a notification rendered asynchronously after a click", async () => {
    await page.setContent(`<button onclick="setTimeout(() => {
      const toast = document.createElement('div'); toast.setAttribute('role', 'status');
      toast.textContent = 'Item added to cart'; document.body.append(toast);
    }, 120)">Add</button>`);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    expect(await captureEarlyNotificationFact(page, request, criteria, "step_cp")).toMatchObject({ value: true, provenance: "DOM_VERIFIED" });
  });

  it("keeps the user's literal authoritative when the generated description names another message", async () => {
    await page.setContent('<div role="status">Item added to cart</div>');
    const other = [{ ...criteria[0]!, sourceText: "popup Order created should be displayed" }];
    expect(await captureEarlyNotificationFact(page, request, other, "step_cp")).toBeNull();
  });

  it("reads notification text when the compiler uses a text check instead of a visibility check", async () => {
    await page.setContent('<div role="status">Item added to cart</div>');
    const textCheck: AcceptanceCriterion = { ...criteria[0]!, sourceText: "popup Item added to cart should be displayed",
      expectedOutcome: { kind: "text_matches", fact: { key: "popup", checkpoint: "after_add" }, match: { mode: "contains", value: "Item added to cart", caseSensitive: false } } };
    expect(await captureEarlyNotificationFact(page, { ...request, valueType: "string", description: "The text of the popup shown after clicking Add to cart" }, [textCheck], "step_cp"))
      .toMatchObject({ value: "Item added to cart", provenance: "DOM_VERIFIED", read: { mode: "text" } });
  });

  it.each(["visible", "text_matches"] as const)("passes the luggage-page, transient-popup and cart-count flow despite a slow model read (%s)", async (popupKind) => {
    const targetUrl = "http://klarna.test/";
    await page.route(`${targetUrl}**`, (route) => route.fulfill({ contentType: "text/html", body:
      route.request().url().includes("/products/")
        ? `<h1>Travel Luggage Set</h1><button id="add">Add to cart</button><span id="count">0</span>
          <script>document.getElementById('add').onclick = () => {
            document.getElementById('count').textContent = '1';
            setTimeout(() => {
              const toast = document.createElement('div'); toast.id = 'toast'; toast.setAttribute('role', 'status');
              toast.textContent = 'Item added to cart'; document.body.append(toast);
              setTimeout(() => toast.remove(), 800);
            }, 120);
          };</script>`
        : '<a id="travel" href="/products/travel_luggage_set">Travel Luggage Set</a>',
    }));
    const ownCriteria: AcceptanceCriterion[] = [
      { ...criteria[0]!, id: "AC-1", expectedOutcome: { kind: "text_matches", fact: { key: "heading", checkpoint: "product" }, match: { mode: "contains", value: "Travel Luggage Set", caseSensitive: false } } },
      { ...criteria[0]!, id: "AC-2", sourceText: "popup Item added to cart should be displayed",
        statement: "After clicking add to cart, a popup confirming that the item was added to the cart is shown.",
        expectedOutcome: popupKind === "visible" ? criteria[0]!.expectedOutcome
          : { kind: "text_matches", fact: { key: "popup", checkpoint: "after_add" }, match: { mode: "contains", value: "Item added to cart", caseSensitive: false } } },
      { ...criteria[0]!, id: "AC-3", expectedOutcome: { kind: "numeric_compare", left: { key: "count", checkpoint: "after_add" }, operator: "eq", right: 1 } },
    ];
    const requirement: NormalizedRequirement = { runId: "run_toast", revision: 1, confirmedAt: new Date().toISOString(),
      originalText: "Click Travel Luggage Set; verify its page, add to cart, verify Item added to cart and cart count 1", criteria: ownCriteria,
      facts: [{ key: "heading", checkpoint: "product", description: "Product heading", valueType: "string" },
        { ...request, valueType: popupKind === "visible" ? "boolean" : "string", description: "Whether a popup stating the item was added to the cart is visible after clicking Add to cart" },
        { key: "count", checkpoint: "after_add", description: "Cart count", valueType: "number" }],
    };
    const plan: TestPlan = { runId: "run_toast", requirementRevision: 1, blockedCriteria: [], stopConditions: [], scenarios: [{
      id: "SC-1", title: "Luggage", criterionIds: ["AC-1", "AC-2", "AC-3"], steps: [
        { id: "PS-1", kind: "navigate", description: "Open store", criterionIds: [], destructive: false },
        { id: "PS-2", kind: "click", description: "Click Travel Luggage Set", criterionIds: ["AC-1"], destructive: false },
        { id: "PS-3", kind: "capture_checkpoint", description: "Read product", checkpoint: "product", criterionIds: ["AC-1"], destructive: false },
        { id: "PS-4", kind: "click", description: "Click Add to cart", criterionIds: ["AC-2", "AC-3"], destructive: false },
        { id: "PS-5", kind: "wait_for", description: "Wait for the popup", criterionIds: ["AC-2"], destructive: false },
        { id: "PS-6", kind: "capture_checkpoint", description: "Read result", checkpoint: "after_add", criterionIds: ["AC-2", "AC-3"], destructive: false },
      ],
    }] };
    const session: ExplorerSession = {
      page,
      navigate: async (url) => { await page.goto(url); return { url: page.url() }; },
      observe: async (instruction) => {
        if (instruction === "Wait for the popup") {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          return { elements: [], llm: null };
        }
        return { elements: [{ selector: instruction.includes("Product heading") ? "h1"
          : instruction.includes("Cart count") ? "#count" : instruction.includes("Add to cart") ? "#add" : "#travel",
          description: instruction, method: "click", arguments: [] }], llm: null };
      },
      act: async () => { throw new Error("Only replay an observed action"); },
      actOn: async (element) => { await page.locator(element.selector).click(); return { success: true, message: "clicked", element, navigationBlocks: [], llm: null }; },
      extract: async (_instruction, schema) => {
        // Longer than the notification's lifetime: its DOM evidence must already have been captured.
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return { data: schema.parse({ heading: "Travel Luggage Set", count: 1 }), llm: null };
      },
      screenshot: () => page.screenshot(), close: async () => {},
    };
    const signal = new AbortController().signal;
    const ctx: StageContext = { runId: "run_toast", tenantId: "t_default", signal, deadlineAt: null,
      request: { targetUrl, requirement: requirement.originalText, browser: "chromium", environment: "staging", testData: {}, secretNames: [],
        options: { maxRunSeconds: 60, maxExplorationSteps: 40, generatePlaywright: true, rerunGeneratedTest: false, autoConfirmCriteria: true, allowDestructiveActions: false, additionalAllowedHosts: [] } },
      budgets: { explorationMs: 60_000, rerunMs: 30_000 }, secrets: { names: [], get: () => undefined }, redact: (v) => v,
      publish: async () => {}, addCleanup: () => {}, boundary: async () => {}, budgetSignal: () => signal, now: () => new Date(), llm: null,
    };
    let artifacts = 0;
    const outcome = await runExploration(ctx, { plan, requirement, session, budget: signal }, { store: {
      saveFact: async () => {}, saveStep: async () => {}, saveScreenshot: async () => ({ artifactId: `art_${++artifacts}` }),
    } });
    const provisional = ownCriteria.map((criterion) => verifyCriterion({ criterion, facts: outcome.facts, steps: outcome.steps, blocked: [], stopReason: outcome.stopReason, plan }));
    const results = provisional.map((result) => reconcile(result, "UNAVAILABLE", outcome.facts, { evidenceArtifactIds: [], relatedStepIds: [], aiNote: null }));
    expect(await page.locator("#toast").count()).toBe(0);
    expect(results.map((r) => [r.criterionId, r.status, r.verdictSource])).toEqual([
      ["AC-1", "PASS", "EXPLORATION_ONLY"], ["AC-2", "PASS", "EXPLORATION_ONLY"], ["AC-3", "PASS", "EXPLORATION_ONLY"],
    ]);
    expect(compilePlaywrightTest({ requirement, plan, provisional, steps: outcome.steps, facts: outcome.facts, targetUrl, secretNames: [], testData: {} }).compiledCriteria).toEqual(["AC-1", "AC-2", "AC-3"]);
  });
});
