// Run explicitly: node tests/shopware/verify.mjs [case-id ...]
// Live external-site checks are kept outside the deterministic CI test projects.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';

const origin = 'https://frontends-demo.vercel.app';
const cases = JSON.parse(await fs.readFile(new URL('./cases.json', import.meta.url), 'utf8'));
const output = new URL('../../.artifacts/shopware/', import.meta.url);
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
if (process.argv.length > 2) {
  try {
    results.push(...JSON.parse(await fs.readFile(new URL('baseline.json', output), 'utf8'))
      .filter(r => !process.argv.slice(2).includes(r.id)));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const checks = {
  async 'cart-lifecycle'(page, record) {
    await page.getByRole('button', { name: 'Increase quantity', exact: true }).click();
    assert.equal(await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).inputValue(), '2');
    await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
    await page.getByText('Ice Cream Scoop has been added to cart.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Mini cart', exact: true }).click();
    await page.getByRole('spinbutton', { name: 'Cart item quantity', exact: true }).waitFor();
    assert.equal(await page.getByRole('spinbutton', { name: 'Cart item quantity', exact: true }).inputValue(), '2');
    await page.getByText('€19.80', { exact: true }).first().waitFor();
    record('mini-cart: quantity 2, line price €19.80');
    await page.getByRole('link', { name: 'Go to shopping cart', exact: true }).click();
    await page.getByRole('heading', { name: 'Shopping cart', level: 1, exact: true }).waitFor();
    const summary = page.getByRole('complementary');
    await summary.getByText('€39.80', { exact: true }).waitFor();
    assert.match(await summary.innerText(), /Subtotal\s+€19\.80\s+Shipping costs\s+€20\.00\s+Order total\s+€39\.80/);
    record('full cart: subtotal €19.80, shipping €20.00, total €39.80');
    const quantity = page.getByRole('spinbutton', { name: 'Cart item quantity', exact: true });
    await quantity.fill('3');
    await quantity.press('Tab');
    await summary.getByText('€49.70', { exact: true }).waitFor();
    await page.reload();
    await summary.getByText('€49.70', { exact: true }).waitFor();
    assert.equal(await quantity.inputValue(), '3');
    assert.match(await summary.innerText(), /Subtotal\s+€29\.70\s+Shipping costs\s+€20\.00\s+Order total\s+€49\.70/);
    await page.locator('main').getByRole('listitem').getByText('€29.70', { exact: true }).waitFor();
    record('after update and reload: quantity 3, line/subtotal €29.70, total €49.70');
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByRole('heading', { name: 'Your cart is empty!', exact: true }).waitFor();
    assert.equal(await page.locator('main').getByRole('link', { name: 'Ice Cream Scoop', exact: true }).count(), 0);
    await page.reload();
    await page.getByRole('heading', { name: 'Your cart is empty!', exact: true }).waitFor();
    record('removed final item; empty cart persists after reload');
  },
  async 'guest-wishlist-gate'(page, record) {
    const card = page.locator('div')
      .filter({ has: page.getByTestId('product-box-product-name-link').filter({ hasText: 'Smoking Board Cedar Wood' }) })
      .filter({ has: page.getByRole('button', { name: 'Add to wishlist', exact: true }) }).last();
    await card.getByRole('button', { name: 'Add to wishlist', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: 'Sign in to your account', exact: true }).waitFor();
    await dialog.getByRole('textbox', { name: 'Email address', exact: true }).waitFor();
    await dialog.getByLabel('Password', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    record('wishlist action opens login dialog with email, password and sign-in/signup actions');
    await dialog.getByRole('button', { name: 'Sign up', exact: true }).click();
    await page.waitForURL('**/register');
    await page.getByRole('heading', { name: 'I am new here.', exact: true }).waitFor();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('combobox', { name: 'Account type *', exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'First name *', exact: true }).waitFor();
    record('signup opens registration and dismisses login dialog');
  },
  async 'registration-account-toggle'(page, record) {
    const type = page.getByRole('combobox', { name: 'Account type *', exact: true });
    const company = page.getByRole('textbox', { name: 'Company *', exact: true });
    const vat = page.getByRole('textbox', { name: 'VAT ID', exact: true });
    const first = page.getByRole('textbox', { name: 'First name *', exact: true });
    const last = page.getByRole('textbox', { name: 'Last name *', exact: true });
    assert.equal(await type.locator('option:checked').innerText(), 'Private');
    assert.equal(await company.count(), 0);
    assert.equal(await vat.count(), 0);
    await first.fill('Regression');
    await last.fill('Tester');
    await type.selectOption({ label: 'Company' });
    await company.waitFor();
    await vat.waitFor();
    await company.fill('Example QA');
    await vat.fill('QA-123456');
    record('Private hides company fields; Company reveals both fields');
    await type.selectOption({ label: 'Private' });
    await company.waitFor({ state: 'hidden' });
    await vat.waitFor({ state: 'hidden' });
    assert.equal(await first.inputValue(), 'Regression');
    assert.equal(await last.inputValue(), 'Tester');
    await type.selectOption({ label: 'Company' });
    await company.waitFor();
    await vat.waitFor();
    assert.equal(await first.inputValue(), 'Regression');
    assert.equal(await last.inputValue(), 'Tester');
    record('Company → Private → Company preserves both personal names');
  },
  async 'search-no-match'(page, record) {
    const query = 'codex-no-product-20261109';
    const search = page.getByRole('textbox', { name: 'Search for products', exact: true });
    await search.fill(query);
    await search.press('Enter');
    await page.waitForURL(`**/search?search=${query}`);
    await page.getByRole('heading', { level: 1 }).filter({ hasText: query }).waitFor();
    await page.getByRole('combobox', { name: 'Per Page:', exact: true }).waitFor();
    await page.waitForLoadState('networkidle');
    const before = await page.locator('main').getByRole('heading', { level: 2 }).allTextContents();
    record(`search result products: ${JSON.stringify(before)}`);
    await page.reload();
    await page.getByRole('combobox', { name: 'Per Page:', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    await page.waitForLoadState('networkidle');
    const after = await page.locator('main').getByRole('heading', { level: 2 }).allTextContents();
    record(`after reload products: ${JSON.stringify(after)}`);
    assert.equal(before.length, 0, 'A nonexistent query must return zero products before reload');
    assert.equal(after.length, 0, 'A nonexistent query must return zero products after reload');
  },
};

try {
  for (const testCase of cases.filter(c => process.argv.length < 3 || process.argv.slice(2).includes(c.id))) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    page.setDefaultTimeout(45_000);
    const result = { id: testCase.id, title: testCase.title, startedAt: new Date().toISOString(), checkpoints: [] };
    try {
      await page.goto(testCase.targetUrl);
      // The guest header is client rendered, unlike the server-rendered form controls.
      await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
      await checks[testCase.id](page, text => result.checkpoints.push(text));
      result.verdict = 'PASSED';
    } catch (error) {
      result.verdict = error instanceof assert.AssertionError ? 'FAILED' : 'ERRORED';
      result.error = error.message;
    } finally {
      result.url = page.url();
      result.finishedAt = new Date().toISOString();
      result.matchesBaseline = result.verdict === testCase.expectedVerdict;
      await page.screenshot({ path: new URL(`${testCase.id}.png`, output).pathname, fullPage: true });
      await fs.writeFile(new URL(`${testCase.id}.txt`, output), await page.locator('body').innerText());
      await context.tracing.stop({ path: new URL(`${testCase.id}.zip`, output).pathname });
      await context.close();
      results.push(result);
      console.log(JSON.stringify(result));
      await fs.writeFile(new URL('baseline.json', output), JSON.stringify(results, null, 2) + '\n');
    }
  }
} finally {
  await browser.close();
}
// Known product failures remain failures; matching a known defect never turns the test green.
if (results.some(r => r.verdict !== 'PASSED')) process.exitCode = 1;
