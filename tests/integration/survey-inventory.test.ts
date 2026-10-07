import { INVENTORY_SCRIPT, parseRawInventory } from "@platform/testing-engine";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The survey's in-page inventory script in real Chromium (transpiled with keepNames, as the worker runs).
 * The login form is shaped like demoqa.com/login: its buttons are type="button", and the one that opens the
 * registration page sits inside the form (run_0muxw7z9b62ec85ca946b2687: the analysis read "no registration link").
 */

const LOGIN_PAGE = `<!doctype html><title>Login</title>
<h1>Login</h1>
<form id="userForm">
  <label for="userName">UserName :</label><input id="userName" type="text" placeholder="UserName">
  <label for="password">Password :</label><input id="password" type="password" placeholder="Password">
  <button id="login" type="button">Login</button>
  <button id="newUser" type="button">New User</button>
</form>
<form id="search"><input type="search" aria-label="Search"><button type="submit">Search</button></form>
<button type="button">Accept cookies</button>`;

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

describe("INVENTORY_SCRIPT in a real page", () => {
  it("lists the buttons inside a form, except the one recorded as the form's submit", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(LOGIN_PAGE);
      const inventory = parseRawInventory(await page.evaluate(INVENTORY_SCRIPT));
      expect(inventory.forms.map((f) => f.submit)).toEqual(["", "Search"]);
      expect(inventory.buttons).toEqual(["Login", "New User", "Accept cookies"]);
    } finally {
      await page.close();
    }
  });
});
