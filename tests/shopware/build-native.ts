/** Explicit recipes emitted in the platform compiler's restricted grammar. */
import { HELPERS_SOURCE } from '../../packages/testing-engine/src/compiler/helpers-template';
import { checkGeneratedTest } from '../../packages/testing-engine/src/playwright-runner/runner';

export function buildNative(id: string, requirement: any, targetUrl: string) {
  const data: any = { targetUrl, urls: {}, locators: {}, inputs: {}, criteria: {} };
  for (const c of requirement.criteria) data.criteria[c.id] = { statement: c.statement };
  let inputs = 0, locators = 0, actions = 0, urls = 0;
  const lines: string[] = [];
  const value = (text: string) => { const key = `input${++inputs}`; data.inputs[key] = text; return `data.inputs.${key}`; };
  const role = (role: string, name = '') => {
    const key = `loc${++locators}`; data.locators[key] = { name };
    return `page.getByRole(${JSON.stringify(role)}, { name: data.locators.${key}.name, exact: true })`;
  };
  const css = (selector: string) => {
    const key = `loc${++locators}`; data.locators[key] = { selector };
    return `page.locator(data.locators.${key}.selector)`;
  };
  const text = (text: string, base = 'page') => `${base}.getByText(${value(text)}, { exact: true })`;
  const emit = (line: string) => lines.push(line);
  const go = (url: string) => {
    const key = `url${++urls}`; data.urls[key] = url;
    emit(`await page.goto(data.urls.${key});`);
    emit('await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});');
  };
  const act = (locator: string, method = 'click', arg?: string) => {
    const key = `action${++actions}`;
    emit(`const ${key} = trackActionRequests(page);`);
    emit(`await ${locator}.${method}(${arg === undefined ? '' : value(arg)});`);
    emit(`await ${key}();`);
  };
  const fill = (locator: string, content: string) => emit(`await ${locator}.fill(${value(content)});`);
  const visible = (locator: string) => `await expect.soft(${locator}, message).toBeVisible();`;
  const hidden = (locator: string) => `await expect.soft(${locator}, message).toBeHidden();`;
  const content = (locator: string, expected: string) => `await expect.soft(${locator}, message).toContainText(${value(expected)}, { useInnerText: true });`;
  const input = (locator: string, expected: string) => `await softExpect.poll(() => readText(${locator}, 0), { message }).toBe(${value(expected)});`;
  const check = (n: number, ...assertions: string[]) => {
    const key = `AC-${n}`;
    emit(`await test.step("[${key}] " + data.criteria["${key}"].statement, async () => {`);
    emit(`const message = "[${key}] " + data.criteria["${key}"].statement;`);
    assertions.forEach(emit);
    emit('});');
  };
  go(targetUrl);
  const signIn = role('button', 'Sign in');
  // Hard assertion: a failed hydration wait must not execute interactions against inert HTML.
  emit(`await expect(${signIn}).toBeVisible({ timeout: 45000 });`);

  if (id === 'cart-lifecycle') {
    const quantity = role('spinbutton', 'Cart item quantity');
    const summary = role('complementary');
    check(1, visible(text('€9.90')));
    check(2, visible(signIn));
    act(role('button', 'Increase quantity'));
    check(3, input(role('spinbutton', 'Quantity'), '2'));
    act(role('button', 'Add to cart'));
    check(4, visible(text('Ice Cream Scoop has been added to cart.')));
    act(role('button', 'Mini cart'));
    check(5, input(quantity, '2'));
    check(6, visible(text('€19.80', role('listitem'))));
    act(role('link', 'Go to shopping cart'));
    emit(`await expect(${role('heading', 'Shopping cart')}).toBeVisible();`);
    check(7, visible(text('€19.80', summary)));
    check(8, visible(text('€20.00', summary)));
    check(9, visible(text('€39.80', summary)));
    fill(quantity, '3');
    act(quantity, 'press', 'Tab');
    emit(`await expect(${text('€49.70', summary)}).toBeVisible();`);
    check(10, input(quantity, '3'));
    check(11, visible(text('€29.70', role('listitem'))));
    check(12, visible(text('€29.70', summary)));
    check(13, visible(text('€49.70', summary)));
    go('https://frontends-demo.vercel.app/checkout/cart');
    check(14, input(quantity, '3'));
    check(15, visible(text('€29.70', summary)));
    check(16, visible(text('€49.70', summary)));
    act(role('button', 'Remove'));
    const empty = role('heading', 'Your cart is empty!');
    const product = role('link', 'Ice Cream Scoop');
    check(17, visible(empty));
    check(18, hidden(product));
    go('https://frontends-demo.vercel.app/checkout/cart');
    check(19, visible(empty));
    check(20, hidden(product));
  } else if (id === 'guest-wishlist-gate') {
    const dialog = css('[role="dialog"], dialog');
    const cardSelector = 'div.p-px:has([data-testid="product-box-product-name-link"][href="/Smoking-Board-Cedar-Wood/943280"])';
    const card = css(cardSelector);
    check(1, visible(card), content(card, 'Smoking Board Cedar Wood'), content(card, '€17.90'),
      hidden(css('[class*="swiper-slide"] [href="/Smoking-Board-Cedar-Wood/943280"]')));
    act(css(`${cardSelector} button[aria-label="Add to wishlist"]`));
    check(2, visible(role('heading', 'Sign in to your account')));
    check(3, visible(dialog + `.getByRole("textbox", { name: ${value('Email address')}, exact: true })`));
    check(4, visible(dialog + `.getByLabel(${value('Password')}, { exact: true })`));
    check(5, visible(dialog + `.getByRole("button", { name: ${value('Sign in')}, exact: true })`));
    check(6, visible(role('button', 'Sign up')));
    act(role('button', 'Sign up'));
    check(7, `await softExpect.poll(() => page.url(), { message }).toBe(${value('https://frontends-demo.vercel.app/register')});`);
    check(8, hidden(dialog));
    check(9, visible(role('heading', 'I am new here.')));
    check(10, visible(role('combobox', 'Account type *')));
    check(11, visible(role('textbox', 'First name *')));
  } else if (id === 'registration-account-toggle') {
    const type = role('combobox', 'Account type *');
    const company = role('textbox', 'Company *');
    const vat = role('textbox', 'VAT ID');
    const first = role('textbox', 'First name *');
    const last = role('textbox', 'Last name *');
    check(1, visible(signIn));
    check(2, hidden(company));
    check(3, hidden(vat));
    fill(first, 'Regression'); fill(last, 'Tester');
    act(type, 'selectOption', 'Company');
    check(4, visible(company)); check(5, visible(vat));
    fill(company, 'Example QA'); fill(vat, 'QA-123456');
    act(type, 'selectOption', 'Private');
    check(6, hidden(company)); check(7, hidden(vat));
    check(8, input(first, 'Regression')); check(9, input(last, 'Tester'));
    act(type, 'selectOption', 'Company');
    check(10, visible(company)); check(11, visible(vat));
    check(12, input(first, 'Regression')); check(13, input(last, 'Tester'));
    check(14, visible(role('heading', 'I am new here.')), visible(role('button', 'Submit')));
  } else if (id === 'search-no-match') {
    check(1, visible(signIn));
    const search = role('textbox', 'Search for products');
    fill(search, 'codex-no-product-20261109');
    act(search, 'press', 'Enter');
    const url = 'https://frontends-demo.vercel.app/search?search=codex-no-product-20261109';
    check(2, `await softExpect.poll(() => page.url(), { message }).toBe(${value(url)});`);
    check(3, content(role('heading', 'Search Result for "codex-no-product-20261109"'), 'codex-no-product-20261109'));
    emit(`await expect(${role('combobox', 'Per Page:')}).toBeVisible();`);
    emit('await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});');
    const grid = css('[data-testid="search-results-container"] .flex.justify-center.flex-wrap');
    check(4, `await softExpect.poll(() => readCount(${grid}, 0), { message }).toBe(0);`);
    check(5, ...['ILARIO Product Variants', 'LAVENDA Product Variants', 'LINE Product Variants', 'Spatial 3D product'].map(name => hidden(role('heading', name))));
    go(url);
    emit(`await expect(${signIn}).toBeVisible({ timeout: 45000 });`);
    check(6, `await softExpect.poll(() => readCount(${grid}, 0), { message }).toBe(0);`);
  } else { throw new Error(`Unknown case ${id}`); }
  const source = [
    '// Explicit reviewed test recipe, emitted in the platform restricted grammar.',
    'import { expect, test } from "@playwright/test";',
    'import { readText, readCount, trackActionRequests } from "./helpers";',
    'import data from "./run-data.json";',
    'const softExpect = expect.configure({ soft: true });',
    'test("discovered flow", async ({ page }) => {', ...lines, '});', '',
  ].join('\n');
  const built = { source, helpersSource: HELPERS_SOURCE, dataJson: JSON.stringify(data, null, 2) };
  const issues = checkGeneratedTest(built);
  if (issues.length) throw new Error(issues.join('\n'));
  return built;
}
