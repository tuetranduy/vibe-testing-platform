import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ElementRef, FactValue } from "@platform/contracts";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFact, type FactReadMode } from "../exploration/fact-reader";
import { locatorFor } from "../exploration/recorder";
import { collapseText, foldText, parseNumber } from "../shared/fact-values";
import { evaluateRule } from "../verification/rules";
import { HELPERS_SOURCE } from "./helpers-template";

/**
 * helpers.ts is a fixed template the generated test imports: its reads and comparisons must mean
 * what the fact reader (Task 14) and the verifier (Task 15) mean, or a rerun could disagree with
 * discovery for no reason. These tests run the template itself (transpiled) against the engine's
 * own functions over the same inputs, so the two cannot drift.
 */

interface Helpers {
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

  it.each(cases)("%s read as %s", async (testId, mode, helper) => {
    const ref = refOf(testId);
    const expected: FactValue | undefined = (await readFact(page, ref, mode))?.value ?? null;
    const read = helpers[helper] as (l: Locator) => Promise<unknown>;
    expect(await read(locatorFor(page, ref.candidates[0]!))).toEqual(expected);
  });
});
