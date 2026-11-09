import { ElementRefSchema, ObservedFactSchema, type ElementRef, type LocatorCandidate } from "@platform/contracts";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LOCATOR_STRATEGY_ORDER } from "../shared/locator-policy";
import { captureCheckpoint, captureFact, modeForValueType, readFact } from "./fact-reader";
import { captureNamedFact, namedFactSubject } from "./named-facts";
import { checkElement, describeElement, describeField, elementAction, fieldValue, fillElement, hittableAlternative, isHittable, reachableNamedControl, recordElement, requiredEmptyFields, selectElementOption } from "./recorder";

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
  <ul data-testid="order-lines">
    <li><span data-testid="line-name">iPhone 17 Pro</span> — Qty 1 — $1,199.00</li>
    <li><span data-testid="line-name">USB-C   Cable</span> — Qty 2 — $38.00</li>
    <li class="subtotal">Subtotal: $1,237.00</li>
  </ul>
  <ul data-testid="plain-lines">
    <li><b class="title">Pixel 11</b> <i class="price">$799.00</i></li>
    <li><b class="title">Galaxy S27</b> <i class="price">$899.00</i></li>
  </ul>
  <main data-testid="empty-cart"><h1>Your cart</h1><p data-testid="cart-empty">Your cart is empty</p><p><a href="/products">Browse products</a></p></main>
  <article data-testid="product"><h1><span>Pixel 11</span></h1><p>$799.00</p><p>A phone.</p><button type="button">Add Pixel</button></article>
  <section><p>Signed in as <strong data-testid="account-email">qa@demo.test</strong></p></section>
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

describe('named fact grounding regressions', () => {
  const request = (description: string, valueType: 'string' | 'number' | 'boolean' = 'boolean') => ({ key: 'subject', checkpoint: 'current', description, valueType });

  it('reads the actual named input, including required markers, instead of a model summary or label', async () => {
    await page.setContent('<label for="first">First name *</label><input id="first" value="Regression"><label for="last">Last name *</label><input id="last" value="Tester">');
    const fact = await captureNamedFact(page, request('Current value of the Last name input after switching back to Private', 'string'), 'text', 'step');
    expect(fact).toMatchObject({ value: 'Tester', provenance: 'DOM_VERIFIED', read: { mode: 'value' } });
    expect(fact?.modelValue).toBeUndefined();
    await page.locator('#last').fill('Changed');
    expect(await readFact(page, fact!.read!.element, 'text')).toMatchObject({ value: 'Changed' });
  });

  it('reads quantity from an input rather than its caption or nearby product price', async () => {
    await page.setContent('<label for="qty">Cart item quantity</label><input type="number" id="qty" value="2"><p>€19.80</p>');
    expect(await captureNamedFact(page, request('Cart item quantity shown for the Ice Cream Scoop line in the mini cart', 'number'), 'number', 'step'))
      .toMatchObject({ value: 2, provenance: 'DOM_VERIFIED', read: { mode: 'number' } });
  });

  it('records an absent named field and detects it if it later appears with a required marker', async () => {
    await page.setContent('<label for="type">Account type *</label><select id="type"><option>Private</option><option>Company</option></select>');
    const fact = await captureNamedFact(page, request('Whether the Company text input is present while Account type is Private'), 'visible', 'step');
    expect(fact).toMatchObject({ value: false, provenance: 'DOM_VERIFIED', read: { element: { candidates: [{ strategy: 'label', text: 'Company', exact: false }] } } });
    await page.locator('body').evaluate(el => { el.insertAdjacentHTML('beforeend', '<label for="company">Company *</label><input id="company">'); });
    expect(await readFact(page, fact!.read!.element, 'visible')).toMatchObject({ value: true });
  });

  it('declines ambiguous or only partially matching fields rather than verifying absence', async () => {
    await page.setContent('<label>First name<input></label><label>First name<input></label><label>Company address<input></label>');
    expect(await captureNamedFact(page, request('Current value of the First name input', 'string'), 'text', 'step')).toBeNull();
    expect(await captureNamedFact(page, request('Whether the Company input is visible'), 'visible', 'step')).toBeNull();
  });

  it('restricts named fields to the requested dialog', async () => {
    await page.setContent('<button>Sign in</button><label>Email address<input value="background"></label><div role="dialog"><button id="modal-sign-in">Sign in</button><label>Email address<input value="dialog"></label></div>');
    expect(await captureNamedFact(page, request('Whether an Email address input is visible inside the login dialog'), 'visible', 'step'))
      .toMatchObject({ value: true, provenance: 'DOM_VERIFIED' });
    const button = await captureNamedFact(page, request('Whether a Sign in button is visible inside the login dialog'), 'visible', 'step');
    expect(button).toMatchObject({ value: true, provenance: 'DOM_VERIFIED' });
    await page.locator('#modal-sign-in').evaluate(el => { (el as HTMLElement).style.display = 'none'; });
    expect(await readFact(page, button!.read!.element, 'visible')).toMatchObject({ value: false });
  });

  it('records a disappearing dialog without confusing another visible modal with that subject', async () => {
    await page.setContent('<h1>Registration</h1>');
    const fact = await captureNamedFact(page, request('Whether the login dialog is still shown after navigating to the registration page'), 'visible', 'step');
    expect(fact).toMatchObject({ value: false, provenance: 'DOM_VERIFIED' });
    await page.locator('body').evaluate(el => { el.insertAdjacentHTML('beforeend', '<div role="dialog">Newsletter</div>'); });
    expect(await readFact(page, fact!.read!.element, 'visible')).toMatchObject({ value: true });
    expect(await captureNamedFact(page, request('Whether the login dialog is visible'), 'visible', 'step')).toBeNull();
    await page.setContent('<dialog>Hidden native dialog</dialog>');
    expect(await captureNamedFact(page, request('Whether the login dialog is visible'), 'visible', 'step'))
      .toMatchObject({ value: false, provenance: 'DOM_VERIFIED' });
  });

  it('grounds a uniquely named card and a removed line without using an expected value to find it', async () => {
    await page.setContent('<a href="/product">Smoking Board Cedar Wood</a>');
    expect(namedFactSubject('Whether the static Smoking Board Cedar Wood product card (943280, €17.90) below Browse collection is visible'))
      .toEqual({ name: 'Smoking Board Cedar Wood', kind: 'product card' });
    expect(await captureNamedFact(page, request('Whether the static Smoking Board Cedar Wood product card is visible'), 'visible', 'step'))
      .toMatchObject({ value: true, provenance: 'DOM_VERIFIED' });
    const fact = await captureNamedFact(page, request('Whether an Ice Cream Scoop line is shown on the cart page after removing the line'), 'visible', 'step');
    expect(fact).toMatchObject({ value: false, provenance: 'DOM_VERIFIED' });
    await page.locator('body').evaluate(el => { el.insertAdjacentHTML('beforeend', '<a href="/scoop">Ice Cream Scoop</a>'); });
    expect(await readFact(page, fact!.read!.element, 'visible')).toMatchObject({ value: true });
    expect(namedFactSubject('Whether any unrelated product card such as ILARIO Product Variants appears in the result grid')).toBeNull();
    expect(await captureNamedFact(page, request('Whether any unrelated product card appears in the result grid'), 'visible', 'step')).toBeNull();
  });

  it('counts repeated result rows instead of the internal children of the first card', async () => {
    await page.setContent('<main><div id="grid">' + Array.from({ length: 12 }, (_, i) => `<article data-testid="card"><img><h2>Product ${i}</h2><p>€10</p><button>Add</button></article>`).join('') + '</div></main>');
    const element = await recordElement(page, 'article:first-child');
    const input = { key: 'products', checkpoint: 'results', stepId: 'step', element, mode: 'count' as const, description: 'Number of product result cards in the search result grid' };
    expect(await captureFact(page, { ...input, modelValue: 4 })).toMatchObject({ provenance: 'MODEL_EXTRACTED', domValue: 12 });
    const fact = await captureFact(page, { ...input, modelValue: 12 });
    expect(fact).toMatchObject({ value: 12, provenance: 'DOM_VERIFIED' });
    await page.locator('#grid').evaluate(el => { el.append(el.firstElementChild!.cloneNode(true)); });
    expect(await readFact(page, fact.read!.element, 'count')).toMatchObject({ value: 13 });
  });

  it('reads an amount beside its requested label and never steals a matching amount from another row', async () => {
    await page.setContent('<aside><div><p id="subtotal">Subtotal</p><p><span>€19.80</span></p></div><div><p>Shipping costs</p><p>€20.00</p></div></aside>');
    const element = await recordElement(page, '#subtotal');
    const base = { key: 'subtotal', checkpoint: 'cart', stepId: 'step', element, mode: 'text' as const, description: 'Order summary Subtotal text on the cart page' };
    const fact = await captureFact(page, { ...base, modelValue: '€19.80' });
    expect(fact).toMatchObject({ value: '€19.80', provenance: 'DOM_VERIFIED' });
    await page.locator('#subtotal + p').evaluate(el => { el.textContent = '€29.70'; });
    expect(await readFact(page, fact.read!.element, 'text')).toMatchObject({ value: '€29.70' });
    expect(await captureFact(page, { ...base, modelValue: '€20.00' })).toMatchObject({ provenance: 'MODEL_EXTRACTED' });
    expect(await captureFact(page, { ...base, description: 'Product price', modelValue: '€29.70' })).toMatchObject({ provenance: 'MODEL_EXTRACTED' });
  });
});

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

describe("elementAction (what a cached element does, KI-032)", () => {
  it("names the tag and type, a link's target and a form's action and method, never a query", async () => {
    await page.setContent(`
      <a id="link" href="/account/orders?session=abc#top">Orders</a>
      <form action="https://pay.example/checkout?cart=1" method="POST"><button id="pay" type="submit">Pay</button></form>
      <form><button id="self" formaction="/cart/add" formmethod="post">Add</button></form>
      <button id="plain" type="button">Nothing</button>`);
    expect(await elementAction(page, "#link")).toBe("a||http://fixture.test/account/orders||");
    expect(await elementAction(page, "#pay")).toBe("button|submit||https://pay.example/checkout|post");
    expect(await elementAction(page, "#self")).toBe("button|||http://fixture.test/cart/add|post");
    expect(await elementAction(page, "#plain")).toBe("button|button|||");

    // Same button, moved into a form that posts elsewhere: a different action.
    await page.evaluate(() => document.querySelector("form")!.setAttribute("action", "https://evil.example/steal"));
    expect(await elementAction(page, "#pay")).toBe("button|submit||https://evil.example/steal|post");
  });
});

describe("fillElement (our code fills; values never go through the model)", () => {
  it("the executor's password-field fallback selector finds the only visible one and fills it (KI-001)", async () => {
    await page.setContent(`<form><input type="password" name="hidden" style="display:none"><label>Password <input type="password" name="pw"></label></form>`);
    const selector = 'input[type="password"] >> visible=true';
    const ref = await recordElement(page, selector);
    expect(ref.candidates[ref.chosenIndex]).toMatchObject({ strategy: "role", role: "textbox", name: "Password" });
    await fillElement(page, selector, "pw-value");
    expect(await page.locator('input[name="pw"]').inputValue()).toBe("pw-value");
  });

  it("fills the located field deterministically", async () => {
    await fillElement(page, "xpath=/html[1]/body[1]/input[1]", "s3cret-value");
    expect(await page.locator("#email").inputValue()).toBe("s3cret-value");
  });});

describe("fieldValue (what a filled field holds now, KI-044)", () => {
  it("reads a field the page emptied after it was filled; null for a field that is gone, hidden or holds no value", async () => {
    await page.setContent(`<input id="first"><input id="gone" style="display:none"><div id="text">Hello</div><select id="size"><option>S</option><option>M</option></select>`);
    await fillElement(page, "#first", "John");
    expect(await fieldValue(page, "#first")).toBe("John");
    // The page resets its form while it starts up.
    await page.evaluate(() => void ((document.getElementById("first") as HTMLInputElement).value = ""));
    expect(await fieldValue(page, "#first")).toBe("");
    expect(await fieldValue(page, "#gone")).toBeNull();
    expect(await fieldValue(page, "#missing")).toBeNull();
    expect(await fieldValue(page, "#text")).toBeNull();
    expect(await fieldValue(page, "input")).toBeNull(); // more than one match
    expect(await fieldValue(page, "#size")).toBe("S");
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

  it("text_list with an item selector reads that sub-element of each row; rows without it are dropped", async () => {
    const ref = await recordElement(page, "[data-testid=order-lines]");
    expect(await readFact(page, ref, "text_list", '[data-testid="line-name"]')).toMatchObject({ value: ["iPhone 17 Pro", "USB-C Cable"] });
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

  it("list rows holding more than the model's items: the sub-element that holds them in every row is recorded (DOM_VERIFIED)", async () => {
    const element = await recordElement(page, "[data-testid=order-lines]");
    const fact = await captureFact(page, { ...base, key: "lineNames", modelValue: ["iPhone 17 Pro", "usb-c cable"], element, mode: "text_list" });
    expect(fact).toMatchObject({
      value: ["iPhone 17 Pro", "USB-C Cable"],
      provenance: "DOM_VERIFIED",
      modelValue: ["iPhone 17 Pro", "usb-c cable"],
      read: { element, mode: "text_list", itemSelector: '[data-testid="line-name"]' },
    });
    expect(ObservedFactSchema.parse(fact)).toEqual(fact);
  });

  it("a row itself can be the item: a message in place of the list (an empty cart) is read alone (KI-001)", async () => {
    // The explorer points at the page's main container; the model reads the message shown in place of the list.
    const element = await recordElement(page, "[data-testid=empty-cart]");
    const fact = await captureFact(page, { ...base, key: "cartItems", modelValue: ["Your cart is empty"], element, mode: "text_list" });
    expect(fact).toMatchObject({ value: ["Your cart is empty"], provenance: "DOM_VERIFIED", read: { mode: "text_list", itemSelector: '[data-testid="cart-empty"]' } });
    expect(await readFact(page, element, "text_list", '[data-testid="cart-empty"]')).toMatchObject({ value: ["Your cart is empty"] });
  });

  it("without a test id, the row sub-element is found by tag and class", async () => {
    const element = await recordElement(page, "[data-testid=plain-lines]");
    const fact = await captureFact(page, { ...base, key: "titles", modelValue: ["Pixel 11", "Galaxy S27"], element, mode: "text_list" });
    expect(fact).toMatchObject({ value: ["Pixel 11", "Galaxy S27"], provenance: "DOM_VERIFIED", read: { mode: "text_list", itemSelector: "b.title" } });
  });

  it("list rows the model's items do not exactly match through one sub-element stay MODEL_EXTRACTED", async () => {
    const element = await recordElement(page, "[data-testid=order-lines]");
    // "iPhone 17" is only part of a sub-element's text; "iPhone 17 Pro" alone is one row short.
    for (const modelValue of [["iPhone 17", "USB-C Cable"], ["iPhone 17 Pro"], ["USB-C Cable", "iPhone 17 Pro"]]) {
      const fact = await captureFact(page, { ...base, key: "lineNames", modelValue, element, mode: "text_list" });
      expect(fact).toMatchObject({ value: modelValue, provenance: "MODEL_EXTRACTED", read: { element, mode: "text_list" } });
      expect(fact.read).not.toHaveProperty("itemSelector");
      expect((fact.domValue as string[])[0]).toBe("iPhone 17 Pro — Qty 1 — $1,199.00");
    }
  });

  it("a text the model read from around the located element: the ancestor whose text it is is recorded (DOM_VERIFIED)", async () => {
    // The model reads "Signed in as qa@demo.test"; the element it points at holds only the address (KI-001).
    const element = await recordElement(page, "[data-testid=account-email]");
    const fact = await captureFact(page, { ...base, key: "accountLine", modelValue: "signed in as  QA@demo.test", element, mode: "text" });
    expect(fact).toMatchObject({ value: "Signed in as qa@demo.test", provenance: "DOM_VERIFIED", modelValue: "signed in as  QA@demo.test", read: { mode: "text" } });
    expect(fact.read!.element).not.toEqual(element);
    expect(await readFact(page, fact.read!.element, "text")).toMatchObject({ value: "Signed in as qa@demo.test" });
    expect(ObservedFactSchema.parse(fact)).toEqual(fact);

    // Only an exact (normalized) match: part of the line, or more than any ancestor holds, stays MODEL_EXTRACTED.
    for (const modelValue of ["Signed in as", "Shop Signed in as qa@demo.test and more"]) {
      const other = await captureFact(page, { ...base, key: "accountLine", modelValue, element, mode: "text" });
      expect(other).toMatchObject({ value: modelValue, provenance: "MODEL_EXTRACTED", domValue: "qa@demo.test", read: { element } });
    }
  });

  it("a text the model read inside the located element: the element inside that holds it is recorded (DOM_VERIFIED)", async () => {
    // The explorer points at the whole product card; the model reads the product name only (KI-001).
    const element = await recordElement(page, "[data-testid=product]");
    const fact = await captureFact(page, { ...base, key: "productName", modelValue: "pixel 11", element, mode: "text" });
    expect(fact).toMatchObject({ value: "Pixel 11", provenance: "DOM_VERIFIED", read: { mode: "text" } });
    // The outermost element holding exactly that text (the h1, not its span).
    expect(fact.read!.element.candidates[fact.read!.element.chosenIndex]).toMatchObject({ strategy: "role", role: "heading", name: "Pixel 11" });
    expect(ObservedFactSchema.parse(fact)).toEqual(fact);

    const partial = await captureFact(page, { ...base, key: "productName", modelValue: "Pixel", element, mode: "text" });
    expect(partial).toMatchObject({ provenance: "MODEL_EXTRACTED", read: { element } });
  });

  it("a boolean fact without an explicit visible mode stays MODEL_EXTRACTED even when the element is visible (R24)", async () => {
    // e.g. "Add to cart is disabled": the model says true; visibility would measure something else.
    const element = await recordElement(page, "#add");
    const fact = await captureFact(page, { key: "addDisabled", checkpoint: "c1", stepId: "s1", modelValue: true, element, mode: null });
    expect(fact).toEqual({ key: "addDisabled", checkpoint: "c1", stepId: "s1", value: true, provenance: "MODEL_EXTRACTED", read: null, modelValue: true });
    expect(ObservedFactSchema.parse(fact)).toEqual(fact);

    const noDefault = await captureFact(page, { key: "addDisabled", checkpoint: "c1", stepId: "s1", modelValue: true, element, mode: modeForValueType("boolean") });
    expect(noDefault.provenance).toBe("MODEL_EXTRACTED");

    // Only when the caller asks for a visibility read (a `visible` expectedOutcome) is it DOM-verified.
    const visible = await captureFact(page, { key: "addShown", checkpoint: "c1", stepId: "s1", modelValue: true, element, mode: "visible" });
    expect(visible).toMatchObject({ value: true, provenance: "DOM_VERIFIED", read: { mode: "visible" } });
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

describe("describeField (what a generated value must suit, 2026-10-07)", () => {
  it("reads a text field's type, name, label, placeholder, autocomplete and limits", async () => {
    await page.setContent(`<label for="z">ZIP code</label><input id="z" name="zip" type="text" placeholder="12345" autocomplete="postal-code" maxlength="5" pattern="[0-9]{5}">`);
    expect(await describeField(page, "#z")).toEqual({
      tag: "input",
      type: "text",
      name: "zip",
      label: "ZIP code",
      placeholder: "12345",
      autocomplete: "postal-code",
      maxLength: 5,
      min: null,
      max: null,
      pattern: "[0-9]{5}",
      options: [],
    });
  });

  it("reads a select's options and an aria-label; a number field's min and max", async () => {
    await page.setContent(`<select id="c" aria-label="Country"><option value="">Choose…</option><option value="no">Norway</option></select><input id="q" type="number" min="1" max="9">`);
    expect(await describeField(page, "#c")).toMatchObject({ tag: "select", type: null, label: "Country", options: [{ value: "", label: "Choose…" }, { value: "no", label: "Norway" }] });
    expect(await describeField(page, "#q")).toMatchObject({ tag: "input", type: "number", min: "1", max: "9", maxLength: null });
  });
});

describe("requiredEmptyFields (a form's required fields the plan left empty, KI-062)", () => {
  /** Like Shopware's register form: "*" labels without `required`, a natively required country, an optional salutation. */
  const FORM = `
    <form id="f">
      <label for="type">Account type *</label><select id="type"><option value="private" selected>Private</option></select>
      <label for="sal">Salutation</label><select id="sal"><option value="">Choose salutation...</option><option value="mr">Mr.</option></select>
      <label for="first">First name *</label><input id="first" name="firstName">
      <label for="email">Email address *</label><input id="email" type="email">
      <label for="pw">Password *</label><input id="pw" type="password">
      <label for="street">Street address *</label><input id="street" value="">
      <input id="hidden" type="hidden" required>
      <input id="gone" required style="display:none">
      <input id="off" required disabled>
      <label for="country">Country</label><select id="country" required><option value="">Choose country...</option><option value="de">Germany</option></select>
      <input id="terms" type="checkbox" aria-required="true"><label for="terms">I accept the terms</label>
      <input type="radio" name="g" id="g1" required><input type="radio" name="g" id="g2" required>
      <label for="note">Note</label><textarea id="note"></textarea>
      <button id="submit">Submit</button>
    </form>
    <form><input id="elsewhere" required><button id="other">Go</button></form>`;
  const xp = (id: string) => page.locator(`#${id}`).evaluate((el) => {
    const parts: string[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) {
      let i = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === n.localName) i++;
      parts.unshift(`${n.localName}[${i}]`);
    }
    return `xpath=/${parts.join("/")}`;
  });

  it("lists the empty required fields of the submit control's form (\"*\" labels, required, aria-required), with how to fill each", async () => {
    await page.setContent(FORM);
    await page.fill("#email", "qa@demo.test");
    await page.fill("#pw", "Pw-123456789!");
    const out = await requiredEmptyFields(page, "#submit", [await xp("email")]);
    expect(out.touched).toBe(true);
    expect(out.fields).toEqual([
      { selector: await xp("first"), how: "fill" },
      { selector: await xp("street"), how: "fill" },
      { selector: await xp("country"), how: "select" },
      { selector: await xp("terms"), how: "check" },
      { selector: await xp("g1"), how: "check" },
    ]);
    // Each selector is the field itself.
    for (const f of out.fields) expect(await page.locator(f.selector).count()).toBe(1);
  });

  it("nothing typed into the form: untouched; a control outside any form: nothing; a filled field is no longer listed", async () => {
    await page.setContent(FORM);
    expect((await requiredEmptyFields(page, "#submit", [])).touched).toBe(false);
    expect((await requiredEmptyFields(page, "#other", ["#email"])).touched).toBe(false);
    await page.setContent(`<input id="q" required><button id="b">Go</button>`);
    expect(await requiredEmptyFields(page, "#b", [])).toEqual({ touched: false, fields: [] });
    await page.setContent(FORM);
    for (const id of ["first", "email", "pw", "street"]) await page.fill(`#${id}`, "x");
    await page.selectOption("#country", "de");
    await checkElement(page, "#terms");
    await checkElement(page, "#g2");
    expect((await requiredEmptyFields(page, "#submit", [])).fields).toEqual([]);
  });
});

describe("selectElementOption (a page that drops the first choice, KI-064)", () => {
  /** Like the Shopware register page: the first change re-renders the select back to its placeholder. */
  const DROPS_FIRST = `
    <select id="country" required><option value="" disabled selected>Choose country...</option><option value="se">Sweden</option><option value="ie">Ireland</option></select>
    <script>
      const s = document.getElementById("country");
      let first = true;
      s.addEventListener("change", () => { if (first) { first = false; setTimeout(() => { s.selectedIndex = 0; }, 50); } });
    </script>`;

  it("selects again when the page puts the select back, and ends on the option chosen", async () => {
    await page.setContent(DROPS_FIRST);
    await selectElementOption(page, "#country", "se");
    await page.waitForTimeout(200); // past the page's reset
    expect(await page.locator("#country").inputValue()).toBe("se");
  });

  it("a page that never keeps the choice is an error, not a success", async () => {
    await page.setContent(`<select id="c"><option value="">-</option><option value="a">A</option></select>
      <script>document.getElementById("c").addEventListener("change", (e) => setTimeout(() => { e.target.selectedIndex = 0; }, 20));</script>`);
    await expect(selectElementOption(page, "#c", "a")).rejects.toThrow(/did not keep/);
  });
});

describe("isHittable / hittableAlternative (R2: a carousel's off-screen clone)", () => {
  // A transform carousel, like frontends-demo's product slider: the first slide is a clone moved off-screen inside an
  // overflow-hidden track; the visible slide has the same button (same role, name and test id).
  const CAROUSEL = `<div style="width:400px;overflow:hidden"><div style="display:flex;transform:translateX(-400px)">
    <div style="flex:0 0 400px"><button data-testid="wish" aria-label="Add to wishlist">♡</button></div>
    <div style="flex:0 0 400px"><button data-testid="wish" aria-label="Add to wishlist">♡</button></div>
  </div></div>
  <div style="position:fixed;top:0;left:500px;width:200px;height:200px;background:#000;z-index:10"></div>
  <button id="under" style="position:absolute;top:50px;left:550px">Covered</button>`;
  const CLONE = "xpath=/html[1]/body[1]/div[1]/div[1]/div[1]/button[1]";
  const VISIBLE = "xpath=/html[1]/body[1]/div[1]/div[1]/div[2]/button[1]";

  it("the clone and a covered element are not hittable; the visible slide's button is", async () => {
    await page.setContent(CAROUSEL);
    expect(await isHittable(page, CLONE)).toBe(false);
    expect(await isHittable(page, VISIBLE)).toBe(true);
    expect(await isHittable(page, "#under")).toBe(false);
  });

  it("the clone's role / test id candidates lead to the visible button's XPath", async () => {
    await page.setContent(CAROUSEL);
    const ref = await recordElement(page, CLONE);
    expect(await hittableAlternative(page, ref)).toBe(VISIBLE);
  });

  it("no reachable twin: null", async () => {
    await page.setContent(CAROUSEL);
    const ref = await recordElement(page, "#under");
    expect(await hittableAlternative(page, ref)).toBeNull();
  });
});

describe("reachableNamedControl (KI-072: the named button, not the header link)", () => {
  const PAGE = `<header><a href="/wishlist" aria-label="wishlist">♡</a></header>
  <main><div style="width:300px;overflow:hidden"><div style="transform:translateX(-300px)"><button aria-label="Add to wishlist">♡</button></div></div>
  <button aria-label="Add to wishlist">♡</button><a href="/p/1">Product 1</a></main>`;

  it("the first reachable button whose name contains the step's name; never the link named 'wishlist'", async () => {
    await page.setContent(PAGE);
    expect(await reachableNamedControl(page, "Add to wishlist", ["button"])).toBe("xpath=/html[1]/body[1]/main[1]/button[1]");
    expect(await reachableNamedControl(page, "add to WISHLIST", ["button", "link"])).toBe("xpath=/html[1]/body[1]/main[1]/button[1]");
  });

  it("no element of that role and name: null", async () => {
    await page.setContent(PAGE);
    expect(await reachableNamedControl(page, "Add to cart", ["button", "link"])).toBeNull();
  });
});
