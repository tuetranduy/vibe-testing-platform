import { ElementRefSchema, ObservedFactSchema, type ElementRef, type LocatorCandidate } from "@platform/contracts";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LOCATOR_STRATEGY_ORDER } from "../shared/locator-policy";
import { captureCheckpoint, captureFact, readFact } from "./fact-reader";
import { describeElement, fillElement, recordElement } from "./recorder";

/**
 * Real Chromium (Playwright's build, launched headless without a proxy) on a static fixture
 * served from a routed origin so page.url() is a real http URL.
 */
const FIXTURE_URL = "http://fixture.test/shop";
const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Recorder fixture</title></head>
<body>
  <h1>Shop</h1>
  <button id="add" type="button">Add to cart</button>
  <label for="email">Email</label>
  <input id="email" name="email" type="email">
  <input type="search" placeholder="Search products">
  <section><button type="button">Buy</button></section>
  <section><button type="button" data-testid="buy-secondary">Buy</button></section>
  <div data-testid="spinner"></div>
  <span data-testid="cart-count" role="status" aria-label="Cart items">Cart (3)</span>
  <ul data-testid="cart-items"><li>  Apple  </li><li>
      Banana   split </li></ul>
  <p data-testid="notice">Free   shipping</p>
  <p data-testid="hidden-note" style="display:none">Secret sale</p>
</body></html>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

beforeEach(async () => {
  await page?.close();
  page = await browser.newPage();
  await page.route("http://fixture.test/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: FIXTURE_HTML }),
  );
  await page.goto(FIXTURE_URL);
});

const strategies = (ref: ElementRef) => ref.candidates.map((c) => c.strategy);
const chosen = (ref: ElementRef): LocatorCandidate => ref.candidates[ref.chosenIndex]!;
const rank = (s: LocatorCandidate["strategy"]) => LOCATOR_STRATEGY_ORDER.indexOf(s);

function expectRanked(ref: ElementRef) {
  const ranks = strategies(ref).map(rank);
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  expect(strategies(ref).at(-1)).toBe("xpath");
  expect(ElementRefSchema.parse(ref)).toEqual(ref);
}

describe("recordElement (acted element → ranked locator candidates)", () => {
  it("button with role + name: role candidate first and chosen", async () => {
    const ref = await recordElement(page, "#add");
    expectRanked(ref);
    expect(ref.candidates[0]).toEqual({ strategy: "role", role: "button", name: "Add to cart", exact: true });
    expect(ref.chosenIndex).toBe(0);
    expect(strategies(ref)).toEqual(["role", "text", "css", "xpath"]);
  });

  it("accepts Stagehand's xpath selectors and describes the element via CDP (role, name, labels)", async () => {
    const d = await describeElement(page, "xpath=/html[1]/body[1]/input[1]");
    expect(d).toMatchObject({ tag: "input", role: "textbox", name: "Email", labels: ["Email"], id: "email", nameAttr: "email" });
    expect(d.xpath).toBe("/html[1]/body[1]/input[1]");

    const ref = await recordElement(page, "xpath=/html[1]/body[1]/input[1]");
    expectRanked(ref);
    expect(strategies(ref)).toEqual(["role", "label", "css", "xpath"]);
    expect(chosen(ref)).toEqual({ strategy: "role", role: "textbox", name: "Email", exact: true });
  });

  it("input with a placeholder only gets a placeholder candidate ranked after role", async () => {
    const ref = await recordElement(page, "input[type=search]");
    expectRanked(ref);
    expect(ref.candidates).toContainEqual({ strategy: "placeholder", text: "Search products" });
    expect(strategies(ref)).not.toContain("label");
    expect(["role", "placeholder"]).toContain(chosen(ref).strategy);
  });

  it("a duplicated 'Buy' button falls through to the first candidate unique to the acted element", async () => {
    const first = await recordElement(page, "section:nth-of-type(1) button");
    expectRanked(first);
    expect(first.candidates[0]).toEqual({ strategy: "role", role: "button", name: "Buy", exact: true });
    expect(chosen(first).strategy).toBe("xpath"); // role and text match both buttons
    expect(await page.locator(`xpath=${(chosen(first) as { selector: string }).selector}`).count()).toBe(1);

    const second = await recordElement(page, "section:nth-of-type(2) button");
    expectRanked(second);
    expect(chosen(second)).toEqual({ strategy: "testId", value: "buy-secondary" });
  });

  it("an element with only data-testid is located by it", async () => {
    const ref = await recordElement(page, "div[data-testid=spinner]");
    expect(ref.candidates).toEqual([
      { strategy: "testId", value: "spinner" },
      { strategy: "xpath", selector: "/html[1]/body[1]/div[1]" },
    ]);
    expect(ref.chosenIndex).toBe(0);
  });

  it("rejects selectors that do not match exactly one element", async () => {
    await expect(recordElement(page, "button >> text=Buy")).rejects.toThrow(/exactly one/);
    await expect(recordElement(page, "#missing", { timeoutMs: 200 })).rejects.toThrow(/exactly one/);
  });
});

describe("fillElement (our code fills; values never go through the model)", () => {
  it("fills the located field deterministically", async () => {
    await fillElement(page, "xpath=/html[1]/body[1]/input[1]", "s3cret-value");
    expect(await page.locator("#email").inputValue()).toBe("s3cret-value");
  });
});

describe("fact reads", () => {
  it("number mode parses 'Cart (3)' → 3", async () => {
    const ref = await recordElement(page, "[data-testid=cart-count]");
    expect(await readFact(page, ref, "number")).toMatchObject({ value: 3 });
  });

  it("text_list returns trimmed item names; count counts them", async () => {
    const ref = await recordElement(page, "[data-testid=cart-items]");
    expect(await readFact(page, ref, "text_list")).toMatchObject({ value: ["Apple", "Banana split"] });
    expect(await readFact(page, ref, "count")).toMatchObject({ value: 2 });
  });

  it("visible returns a boolean; text is whitespace-collapsed; value reads inputs", async () => {
    const notice = await recordElement(page, "[data-testid=notice]");
    const hidden = await recordElement(page, "[data-testid=hidden-note]");
    expect(await readFact(page, notice, "visible")).toMatchObject({ value: true });
    expect(await readFact(page, hidden, "visible")).toMatchObject({ value: false });
    expect(await readFact(page, notice, "text")).toMatchObject({ value: "Free shipping" });

    const email = await recordElement(page, "#email");
    await page.locator("#email").fill("a@b.c");
    expect(await readFact(page, email, "value")).toMatchObject({ value: "a@b.c" });
  });

  it("visible is false once the recorded element is gone", async () => {
    const notice = await recordElement(page, "[data-testid=notice]");
    await page.evaluate(() => document.querySelector("[data-testid=notice]")?.remove());
    expect(await readFact(page, notice, "visible")).toMatchObject({ value: false });
    expect(await readFact(page, notice, "text")).toBeNull();
  });
});

describe("captureFact / captureCheckpoint (provenance)", () => {
  const base = { key: "cartCount", checkpoint: "after_add", stepId: "step-4" };

  it("DOM value equals the model value (normalized) → DOM_VERIFIED", async () => {
    const element = await recordElement(page, "[data-testid=cart-count]");
    const fact = await captureFact(page, { ...base, modelValue: "3", element, mode: "number" });
    expect(fact).toMatchObject({ value: 3, provenance: "DOM_VERIFIED", modelValue: "3", read: { element, mode: "number" } });
    expect(ObservedFactSchema.parse(fact)).toEqual(fact);
  });

  it("DOM value differs → MODEL_EXTRACTED with both values kept", async () => {
    const element = await recordElement(page, "[data-testid=cart-count]");
    const fact = await captureFact(page, { ...base, modelValue: 4, element, mode: "number" });
    expect(fact).toMatchObject({ value: 4, provenance: "MODEL_EXTRACTED", modelValue: 4, domValue: 3 });
  });

  it("no locatable element → MODEL_EXTRACTED", async () => {
    const none = await captureFact(page, { ...base, modelValue: 3, element: null, mode: "number" });
    expect(none).toMatchObject({ value: 3, provenance: "MODEL_EXTRACTED", read: null });

    const element = await recordElement(page, "[data-testid=cart-count]");
    await page.evaluate(() => document.querySelector("[data-testid=cart-count]")?.remove());
    const gone = await captureFact(page, { ...base, modelValue: 3, element, mode: "number" });
    expect(gone).toMatchObject({ provenance: "MODEL_EXTRACTED", read: null });
  });

  it("the reserved url fact is captured at every checkpoint as DOM_VERIFIED", async () => {
    const element = await recordElement(page, "[data-testid=cart-count]");
    const facts = await captureCheckpoint(page, {
      checkpoint: "after_add",
      stepId: "step-4",
      facts: [{ key: "cartCount", modelValue: 3, element, mode: "number" }],
    });
    expect(facts.map((f) => [f.key, f.provenance])).toEqual([
      ["url", "DOM_VERIFIED"],
      ["cartCount", "DOM_VERIFIED"],
    ]);
    expect(facts[0]).toEqual({ key: "url", checkpoint: "after_add", value: FIXTURE_URL, provenance: "DOM_VERIFIED", read: null, stepId: "step-4" });

    const onlyUrl = await captureCheckpoint(page, { checkpoint: "empty", stepId: "step-5", facts: [] });
    expect(onlyUrl).toEqual([{ key: "url", checkpoint: "empty", value: FIXTURE_URL, provenance: "DOM_VERIFIED", read: null, stepId: "step-5" }]);
    for (const f of [...facts, ...onlyUrl]) ObservedFactSchema.parse(f);
  });
});
