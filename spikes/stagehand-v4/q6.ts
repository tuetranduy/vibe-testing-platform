// Q6: Current caching option names; is a cache hit reported per call?
// v4 caching = `cache: boolean | { threshold?: number }` on Stagehand.create() and per call (act/observe/extract options).
// It is SERVER-SIDE (Browserbase Stagehand API) and needs a Browserbase apiKey AND a Browserbase sessionId.
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { banner, launchChromium, spikeShopLLM, startSite } from "./lib.ts";

const site = await startSite();
const chrome = await launchChromium();
const browser = await localBrowser.connect({ cdpUrl: chrome.cdpUrl, extensionId: chrome.extensionId });
const llm = spikeShopLLM();
// Instance-level cache on, even with a (dummy) Browserbase apiKey: local browsers have no sessionId.
const stagehand = await Stagehand.create({ browser, model: llm.client, cache: true, apiKey: "bb_dummy_key", logging: { level: "warn" } });
const shPage = (await browser.context.activePage())!;
await shPage.goto(site.url, { waitUntil: "load" });

banner("Q6: repeated identical observe() calls with caching requested");
for (const [i, opts] of [[1, { cache: true }], [2, { cache: true }], [3, { cache: { threshold: 1 } }]] as const) {
  const before = llm.calls.length;
  const r = await stagehand.observe("find the add to cart button", opts);
  console.log(`call ${i} opts=${JSON.stringify(opts)} -> metadata.cache=${JSON.stringify(r.metadata.cache)} | LLM calls: ${llm.calls.length - before}`);
}

await stagehand.close();
await browser.close();
await chrome.kill();
await site.close();
