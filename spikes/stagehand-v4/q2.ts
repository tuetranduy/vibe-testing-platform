// Q2: Can Playwright operate on the same page Stagehand drives (locator counts, page.route, reading text)?
// Both attach to OUR Chromium's CDP endpoint: Stagehand via localBrowser.connect, Playwright via connectOverCDP.
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { chromium } from "playwright-core";
import { z } from "zod";
import { banner, launchChromium, spikeShopLLM, startSite } from "./lib.ts";

const site = await startSite();
const chrome = await launchChromium();
const browser = await localBrowser.connect({ cdpUrl: chrome.cdpUrl, extensionId: chrome.extensionId });
const llm = spikeShopLLM();
const stagehand = await Stagehand.create({ browser, model: llm.client, logging: { level: "warn" } });
const shPage = (await browser.context.activePage())!;

// Playwright attaches to the SAME browser.
const pw = await chromium.connectOverCDP(chrome.cdpUrl);
banner("Q2: Playwright connected over CDP to the same browser");
console.log("playwright contexts:", pw.contexts().length, "pages:", pw.contexts()[0].pages().map((p) => p.url()));

// Install a Playwright route BEFORE Stagehand navigates -> proves interception on the Stagehand-driven page.
const pwPage = pw.contexts()[0].pages().find((p) => p.url() === "about:blank")!;
let routed = 0;
await pwPage.route("**/api/price", (route) => { routed++; return route.fulfill({ json: { price: "CHF 0.99 (mocked by Playwright)" } }); });

await shPage.goto(site.url, { waitUntil: "load" }); // Stagehand navigates
await pwPage.waitForLoadState("load");
console.log("same page? stagehand url:", await shPage.url(), "| playwright url:", pwPage.url());
// Robust mapping: Stagehand's page.pageId IS the CDP targetId.
const { targetInfo } = await (await pwPage.context().newCDPSession(pwPage)).send("Target.getTargetInfo");
console.log("stagehand pageId:", shPage.pageId, "| playwright page CDP targetId:", targetInfo.targetId, "| equal:", shPage.pageId === targetInfo.targetId);

await pwPage.getByText("Price:").waitFor();
console.log("page.route fired:", routed, "time(s); price text via Playwright:", await pwPage.locator("#price").textContent());
console.log("locator counts via Playwright: buttons =", await pwPage.getByRole("button").count(),
  ", 'Add to cart' =", await pwPage.getByRole("button", { name: "Add to cart" }).count(),
  ", textbox/spinbutton 'Quantity' =", await pwPage.getByLabel("Quantity").count());

// Stagehand acts, Playwright observes the effect.
const act = await stagehand.act("click the add to cart button");
console.log("stagehand.act success:", act.data.success, "-> badge via Playwright:", await pwPage.getByTestId("cart-count").textContent());

// Playwright acts, Stagehand observes the effect (Stagehand's own locator + extract).
await pwPage.getByLabel("Quantity").fill("5");
await pwPage.getByRole("button", { name: "Add to cart" }).click();
console.log("after Playwright click -> badge via Stagehand locator:", await shPage.locator("#badge").textContent());
const ex = await stagehand.extract("cart count", z.object({ heading: z.string(), cartCount: z.number() }));
console.log("stagehand.extract sees:", ex.data);

await pw.close(); // disconnects Playwright only (connectOverCDP)
await stagehand.close();
await browser.close();
await chrome.kill();
await site.close();
