import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generateTestDataValue, type ElementRef, type FactValue } from "@platform/contracts";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFact, type FactReadMode } from "../exploration/fact-reader";
import { locatorFor } from "../exploration/recorder";
import { collapseText, foldText, parseNumber } from "../shared/fact-values";
import { evaluateRule } from "../verification/rules";
import { CUSTOM_DROPDOWN, MONTHS } from "../exploration/custom-dropdown.fixture";
import { selectElementOption } from "../exploration/recorder";
import { HELPERS_SOURCE } from "./helpers-template";

/**
 * helpers.ts is a fixed template the generated test imports: its reads and comparisons must mean
 * what the fact reader (Task 14) and the verifier (Task 15) mean, or a rerun could disagree with
 * discovery for no reason. These tests run the template itself (transpiled) against the engine's
 * own functions over the same inputs, so the two cannot drift.
 */

interface Helpers {
  trackActionRequests(page: Page, timeoutMs?: number, quietMs?: number): () => Promise<void>;
  readNumberOrZero(locator: Locator, waitMs?: number): Promise<number | null>;
  parseNumber(text: string): number | null;
  collapseText(s: string | null): string | null;
  foldText(s: string | null): string | null;
  listContains(list: string[] | null, item: string | null, match: "equals" | "contains"): boolean;
  difference(a: number | null, b: number | null): number | null;
  secret(value: string | undefined): string;
  readText(locator: Locator, waitMs?: number): Promise<string | null>;
  readNumber(locator: Locator, waitMs?: number): Promise<number | null>;
  readCount(locator: Locator, waitMs?: number): Promise<number | null>;
  readTextList(locator: Locator, waitMs?: number): Promise<string[] | null>;
  readItemTexts(locator: Locator, itemSelector: string, waitMs?: number): Promise<string[] | null>;
  refreshEmails(data: unknown): void;
  chooseOption(field: Locator, value: string, timeoutMs?: number): Promise<void>;
}

let helpers: Helpers;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "helpers-template-"));
  const js = ts.transpileModule(HELPERS_SOURCE, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const file = path.join(dir, "helpers.mjs");
  writeFileSync(file, js);
  helpers = (await import(pathToFileURL(file).href)) as Helpers;
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const NUMBER_TEXTS = [
  "Cart (3)",
  "3",
  "-2 items",
  "CHF 1,299.50",
  "CHF 1'299.00",
  "CHF 1’299.00",
  "1.234,56 €",
  "12,5 kg",
  "Total: 1,000",
  "1,299,000",
  "1.234.567",
  "1 299",
  "1 299",
  "Items: 4 of 10",
  "0.5",
  "-0,75",
  "Your cart is empty",
  "",
  "1,2,3",
  "v2.0.1",
];

describe("helpers.ts matches the engine", () => {
  it.each(NUMBER_TEXTS)("parseNumber(%j) is the fact reader's parseNumber", (text) => {
    expect(helpers.parseNumber(text)).toBe(parseNumber(text));
  });

  it.each(["  Added   to\nCART ", "ｆｕｌｌ ｗｉｄｔｈ", "Straße", " nbsp ", ""])("collapseText / foldText(%j) normalize like the verifier", (s) => {
    expect(helpers.collapseText(s)).toBe(collapseText(s));
    expect(helpers.foldText(s)).toBe(foldText(s));
  });

  it("listContains decides collection_contains like the verifier's rule", () => {
    const lists = [["iPhone 17 Pro", "USB-C  Cable"], ["Apple iPhone 17 Pro Max"], [], ["ｉＰｈｏｎｅ"]];
    const items = ["iPhone 17 Pro", "iphone 17 pro", "usb-c cable", "USB-C Cable", "Case", "iPhone"];
    for (const list of lists) {
      for (const item of items) {
        for (const match of ["equals", "contains"] as const) {
          const rule = evaluateRule(
            { kind: "collection_contains", collection: { key: "items", checkpoint: "cart" }, item, match },
            () => list,
          );
          expect(helpers.listContains(list, item, match), `${JSON.stringify(list)} ${match} ${item}`).toBe(rule.status === "PASS");
        }
      }
    }
    expect(helpers.listContains(null, "a", "contains")).toBe(false);
    expect(helpers.listContains(["a"], null, "contains")).toBe(false);
  });

  it("difference and secret", () => {
    expect(helpers.difference(3, 1)).toBe(2);
    expect(helpers.difference(null, 1)).toBeNull();
    expect(helpers.difference(1, null)).toBeNull();
    expect(helpers.secret("x")).toBe("x");
    expect(() => helpers.secret(undefined)).toThrow(/secret/i);
  });
});

// ---------------------------------------------------------------------------------------------
// DOM reads: the helpers against the fact reader, on the same page (real Chromium)
// ---------------------------------------------------------------------------------------------

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Helpers fixture</title></head>
<body>
  <span data-testid="cart-count">Cart (3)</span>
  <span data-testid="price">CHF 1'299.50</span>
  <ul data-testid="cart-items"><li>  Apple  </li><li>
      Banana   split </li><li>   </li></ul>
  <ul data-testid="order-lines"><li><span class="name">iPhone 17 Pro</span> — $1,199.00</li><li>Subtotal</li><li><span class="name">USB-C
      Cable</span> — $19.00</li><li><span class="name"> </span> — $0.00</li></ul>
  <main data-testid="main-box"><h1>Your cart</h1><p class="message">Your cart is empty</p><p>Browse</p></main>
  <div data-testid="lines">first line<br>second   line</div>
  <p data-testid="notice">Free   shipping</p>
  <input data-testid="email" value="  a@b.c ">
  <textarea data-testid="note">hello
  world</textarea>
  <p data-testid="dup">x</p><p data-testid="dup">y</p>
</body></html>`;

let browser: Browser;
let page: Page;

describe("helpers.ts DOM reads match the fact reader", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.route("http://fixture.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: FIXTURE_HTML }));
    await page.goto("http://fixture.test/");
  });
  afterAll(async () => {
    await browser?.close();
  });

  const refOf = (testId: string): ElementRef => ({ candidates: [{ strategy: "testId", value: testId }], chosenIndex: 0, framePath: [] });
  const cases: [string, FactReadMode, keyof Helpers][] = [
    ["cart-count", "number", "readNumber"],
    ["price", "number", "readNumber"],
    ["notice", "number", "readNumber"],
    ["cart-count", "text", "readText"],
    ["notice", "text", "readText"],
    ["lines", "text", "readText"],
    ["email", "text", "readText"],
    ["note", "text", "readText"],
    ["cart-items", "text", "readText"],
    ["cart-items", "text_list", "readTextList"],
    ["lines", "text_list", "readTextList"],
    ["notice", "text_list", "readTextList"],
    ["cart-items", "count", "readCount"],
    ["notice", "count", "readCount"],
    ["dup", "text", "readText"],
    ["dup", "number", "readNumber"],
  ];

  it("waitMs 0 (reads inside expect.poll) does not wait for a missing element", async () => {
    const started = Date.now();
    expect(await helpers.readNumber(locatorFor(page, { strategy: "testId", value: "missing" }), 0)).toBeNull();
    expect(await helpers.readText(locatorFor(page, { strategy: "testId", value: "notice" }), 0)).toBe("Free shipping");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("readItemTexts matches a row itself too, as the fact reader does", async () => {
    const ref = refOf("main-box");
    const expected = (await readFact(page, ref, "text_list", "p.message"))?.value;
    expect(expected).toEqual(["Your cart is empty"]);
    expect(await helpers.readItemTexts(locatorFor(page, ref.candidates[0]!), "p.message")).toEqual(expected);
  });

  it.each(["order-lines", "cart-items", "notice", "dup"])("%s read through a row sub-element", async (testId) => {
    const ref = refOf(testId);
    const expected: FactValue | undefined = (await readFact(page, ref, "text_list", "span.name"))?.value ?? null;
    expect(await helpers.readItemTexts(locatorFor(page, ref.candidates[0]!), "span.name")).toEqual(expected);
  });

  it("readItemTexts reads only the sub-element of each row", async () => {
    expect(await helpers.readItemTexts(locatorFor(page, { strategy: "testId", value: "order-lines" }), "span.name")).toEqual(["iPhone 17 Pro", "USB-C Cable"]);
  });

  it.each(cases)("%s read as %s", async (testId, mode, helper) => {
    const ref = refOf(testId);
    const expected: FactValue | undefined = (await readFact(page, ref, mode))?.value ?? null;
    const read = helpers[helper] as (l: Locator) => Promise<unknown>;
    expect(await read(locatorFor(page, ref.candidates[0]!))).toEqual(expected);
  });

  it("readNumberOrZero reads a counter as the verifier does in a numeric_delta: no number shown is 0 (KI-060)", async () => {
    const at = (testId: string) => locatorFor(page, { strategy: "testId", value: testId });
    expect(await helpers.readNumberOrZero(at("cart-count"))).toBe((await readFact(page, refOf("cart-count"), "number"))?.value);
    // The fact reader reads null there; the verifier counts a DOM_VERIFIED null "number" reading as 0.
    expect((await readFact(page, refOf("notice"), "number"))?.value).toBeNull();
    expect(await helpers.readNumberOrZero(at("notice"))).toBe(0);
    expect(await helpers.readNumberOrZero(at("dup"), 0)).toBeNull();
    expect(await helpers.readNumberOrZero(at("missing"), 0)).toBeNull();
  });

  it("a click that loads a route's script and then fetches its data is awaited to the end (KI-058)", async () => {
    const actionPage = await browser.newPage();
    try {
      await actionPage.route("http://route.test/", (route) => route.fulfill({
        contentType: "text/html",
        body: `<button onclick="const s = document.createElement('script'); s.src = '/chunk.js'; document.head.append(s)">Checkout</button>`,
      }));
      await actionPage.route("http://route.test/chunk.js", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await route.fulfill({ contentType: "text/javascript",
          body: "setTimeout(() => fetch('/data').then(() => { history.pushState({}, '', '/checkout'); window.done = true; }), 120);" });
      });
      await actionPage.route("http://route.test/data", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await route.fulfill({ contentType: "application/json", body: "{}" });
      });
      await actionPage.goto("http://route.test/");
      const finish = helpers.trackActionRequests(actionPage);
      await actionPage.getByRole("button", { name: "Checkout" }).click();
      await finish();
      expect(await actionPage.evaluate(() => (window as unknown as { done?: boolean }).done)).toBe(true);
      expect(new URL(actionPage.url()).pathname).toBe("/checkout");
    } finally {
      await actionPage.close();
    }
  });

  it.each(["fetch", "image"] as const)("bounds unfinished fetches and ignores images: %s", async (kind) => {
    const actionPage = await browser.newPage();
    try {
      const action = kind === "fetch" ? 'fetch("/hang")' : 'document.getElementById("image").src = "/hang"';
      await actionPage.route("http://action.test/", (route) => route.fulfill({
        contentType: "text/html",
        body: `<button onclick='${action}'>Start</button><img id="image">`,
      }));
      await actionPage.route("http://action.test/hang", () => {});
      await actionPage.goto("http://action.test/");
      const finish = helpers.trackActionRequests(actionPage, kind === "fetch" ? 100 : 2_000);
      const startedRequest = actionPage.waitForRequest("http://action.test/hang");
      await actionPage.getByRole("button", { name: "Start" }).click();
      await startedRequest;
      const started = Date.now();
      await finish();
      const elapsed = Date.now() - started;
      if (kind === "fetch") expect(elapsed).toBeGreaterThanOrEqual(90);
      // Images are ignored; an unfinished fetch is bounded instead of stalling every subsequent step.
      expect(elapsed).toBeLessThan(1_000);
    } finally {
      await actionPage.close();
    }
  });
});

describe("refreshEmails (KI-077)", () => {
  const made = String(generateTestDataValue("email", { seed: "run_1:new_email" }));
  const runData = () => ({
    targetUrl: "https://shop.example.com/",
    inputs: { input1: made, input2: "jane.doe@company.test", input3: "Test" },
    locators: { loc1: { text: `Welcome, ${made}` }, loc2: { name: made } },
    criteria: { "AC-1": { statement: "The account page shows the new email", count: 3 } },
    list: [made, "other"],
  });

  it("gives a made-up email (the platform's qa.<token>@example.com) a new token, the same wherever that address appears", () => {
    expect(made).toMatch(/^qa\.[0-9a-z]{6}@example\.com$/);
    const data = runData();
    helpers.refreshEmails(data);
    const fresh = data.inputs.input1;
    expect(fresh).toMatch(/^qa\.[0-9a-z]{6}@example\.com$/);
    expect(fresh).not.toBe(made);
    expect(fresh).toHaveLength(made.length);
    expect(data.locators).toEqual({ loc1: { text: `Welcome, ${fresh}` }, loc2: { name: fresh } });
    expect(data.list).toEqual([fresh, "other"]);
  });

  it("gives a made-up username (qa_<token>) a new token too, the same wherever it appears (KI-077)", () => {
    const data = { inputs: { input1: "qa_abc123", input2: "qa_team" }, list: ["qa_abc123"], text: "Hello qa_abc123!" };
    helpers.refreshEmails(data);
    const fresh = data.inputs.input1;
    expect(fresh).toMatch(/^qa_[0-9a-z]{6}$/);
    expect(fresh).not.toBe("qa_abc123");
    expect(data.list).toEqual([fresh]);
    expect(data.text).toBe(`Hello ${fresh}!`);
    expect(data.inputs.input2).toBe("qa_team");
  });

  it("leaves every other value as it is: an email the user entered, other text, numbers", () => {
    const data = runData();
    helpers.refreshEmails(data);
    const { inputs, criteria, targetUrl } = runData();
    expect(data.inputs.input2).toBe(inputs.input2);
    expect(data.inputs.input3).toBe(inputs.input3);
    expect(data.criteria).toEqual(criteria);
    expect(data.targetUrl).toBe(targetUrl);
  });

  it("each execution of the test gets a new address", () => {
    const first = runData();
    const second = runData();
    helpers.refreshEmails(first);
    helpers.refreshEmails(second);
    expect(first.inputs.input1).not.toBe(second.inputs.input1);
  });
});

describe("chooseOption (KI-097) chooses as the recorder's selectElementOption does", () => {
  let chooser: Browser;
  let tab: Page;
  beforeAll(async () => {
    chooser = await chromium.launch({ headless: true });
    tab = await chooser.newPage();
  });
  afterAll(async () => {
    await chooser?.close();
  });

  it.each([
    ["an option inside the widget", {}, "December", "December"],
    ["an option the value starts, in a list appended to the body", { portal: true }, "sept", "September"],
    ["an option shown only once the value is typed", { onlyWhenTyped: true }, "December", "December"],
    ["a widget with a hidden combobox input", { hiddenInput: true }, "December", "December"],
  ] as const)("%s", async (_what, opts, value, expected) => {
    await tab.setContent(CUSTOM_DROPDOWN(MONTHS, opts));
    await helpers.chooseOption(tab.locator("#month-input"), value);
    const replayed = await tab.locator("#month .ng-value").textContent();
    await tab.setContent(CUSTOM_DROPDOWN(MONTHS, opts));
    await selectElementOption(tab, "#month-input", value);
    expect(replayed).toBe(expected);
    expect(await tab.locator("#month .ng-value").textContent()).toBe(replayed);
  });

  it("accepts a selection that replaces the combobox with the chosen value", async () => {
    for (const choose of [
      () => helpers.chooseOption(tab.locator("#month-input"), "December"),
      () => selectElementOption(tab, "#month-input", "December"),
    ]) {
      await tab.setContent(CUSTOM_DROPDOWN(MONTHS, { hiddenInput: true, replacesWidget: true }));
      await choose();
      expect(await tab.locator("#month-input").count()).toBe(0);
    }
  });

  it("fails, like the recorder, on an option the list lacks and on a choice the page drops", async () => {
    await tab.setContent(CUSTOM_DROPDOWN(MONTHS));
    await expect(helpers.chooseOption(tab.locator("#month-input"), "Smarch", 500)).rejects.toThrow(/no option "Smarch".*January/);
    await tab.setContent(CUSTOM_DROPDOWN(MONTHS, { dropsChoice: true }));
    await expect(helpers.chooseOption(tab.locator("#month-input"), "May")).rejects.toThrow(/did not keep/);
  });

  it("uses selectOption on a native select", async () => {
    await tab.setContent(`<select id="s"><option value="">-</option><option value="de">Germany</option></select>`);
    await helpers.chooseOption(tab.locator("#s"), "Germany");
    expect(await tab.locator("#s").inputValue()).toBe("de");
  });
});
