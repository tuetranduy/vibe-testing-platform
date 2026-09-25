// Q4: What does observe() return? Can we act on an observed element ourselves?
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { chromium } from "playwright-core";
import { banner, launchChromium, spikeShopLLM, startSite } from "./lib.ts";

const site = await startSite();
const chrome = await launchChromium();
const browser = await localBrowser.connect({ cdpUrl: chrome.cdpUrl, extensionId: chrome.extensionId });
const llm = spikeShopLLM();
const stagehand = await Stagehand.create({ browser, model: llm.client, logging: { level: "warn" } });
const shPage = (await browser.context.activePage())!;
await shPage.goto(site.url, { waitUntil: "load" });

const obs = await stagehand.observe("find the interactive elements for adding to cart");
banner("Q4: observe() result");
console.log(JSON.stringify(obs, null, 1));

const pw = await chromium.connectOverCDP(chrome.cdpUrl);
const pwPage = pw.contexts()[0].pages().find((p) => p.url() === site.url)!;
const [button, qty] = obs.data;

banner("Q4: act on observed elements ourselves");
// (a) Playwright: the selector string is directly usable ("xpath=..." is a Playwright selector engine).
await pwPage.locator(qty.selector).fill("2");
await pwPage.locator(button.selector).click();
console.log("(a) Playwright locator(observed.selector) -> badge:", await pwPage.getByTestId("cart-count").textContent());
// (b) Stagehand's own Playwright-style locator.
await shPage.locator(button.selector).click();
console.log("(b) stagehand page.locator(observed.selector).click() -> badge:", await shPage.locator("#badge").textContent());
// (c) stagehand.act(Action) replays deterministically: NO LLM call.
const callsBefore = llm.calls.length;
const replay = await stagehand.act(button);
console.log("(c) stagehand.act(observedAction) success:", replay.data.success, "| LLM calls made:", llm.calls.length - callsBefore,
  "| usage:", JSON.stringify(replay.metadata.usage), "-> badge:", await pwPage.getByTestId("cart-count").textContent());

await pw.close();
await stagehand.close();
await browser.close();
await chrome.kill();
await site.close();
