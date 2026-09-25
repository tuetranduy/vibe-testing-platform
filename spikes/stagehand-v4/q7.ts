// Q7: Is a local Chromium mode supported (required for our egress proxy), or is Browserbase mandatory?
// Also shows WHERE Stagehand's own network traffic originates (inside the browser -> through our proxy).
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { banner, CHROMIUM, launchChromium, spikeShopLLM, startLoggingProxy, startSite } from "./lib.ts";

console.log("BROWSERBASE_API_KEY set:", Boolean(process.env.BROWSERBASE_API_KEY), "| OPENAI/ANTHROPIC key set:", Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY));
const site = await startSite();
const proxy = await startLoggingProxy();

banner("Q7a: Stagehand-managed local launch: localBrowser.launch({ executablePath, proxy, args })");
try {
  const b = await localBrowser.launch({
    executablePath: CHROMIUM, headless: true,
    proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: "<-loopback>" },
    args: ["--disable-background-networking"],
  });
  console.log("localBrowser.launch OK:", b.provider, b.origin);
  await b.close();
} catch (e) {
  console.log("localBrowser.launch FAILED on", CHROMIUM.split("/").slice(-3).join("/"), "->", (e as Error).message, JSON.stringify((e as any).cause));
}

banner("Q7b: our own local Chromium + localBrowser.connect (no Browserbase anywhere)");
const chrome = await launchChromium({ proxyPort: proxy.port });
const browser = await localBrowser.connect({ cdpUrl: chrome.cdpUrl, extensionId: chrome.extensionId });
console.log("provider:", browser.provider, "origin:", browser.origin, "sessionId:", browser.sessionId);
const llm = spikeShopLLM();
const stagehand = await Stagehand.create({ browser, model: llm.client, logging: { level: "error" } });
const page = (await browser.context.activePage())!;
await page.goto(site.url, { waitUntil: "load" });
const obs = await stagehand.observe("add to cart");
console.log("observe with ClientLLM (fully local):", obs.data.map((a) => a.selector));

banner("Q7c: provider ModelConfig -> where does inference run?");
proxy.log.length = 0;
try {
  // Per-call override with a provider model config (dummy key): inference is done by the Stagehand
  // runtime INSIDE the browser (AI SDK in the extension service worker), so it egresses via --proxy-server.
  await stagehand.observe("add to cart", { model: { modelName: "openai/gpt-4.1-mini", apiKey: "sk-dummy-spike" }, timeout: 15000 });
} catch (e) {
  console.log("observe with dummy OpenAI key failed as expected:", (e as Error).message.split("\n")[0].slice(0, 160));
}
console.log("proxy log during provider-model observe:", proxy.log.filter((l) => !/google|gstatic|127\.0\.0\.1/.test(l)));

await stagehand.close();
await new Promise((r) => setTimeout(r, 1500));
banner("Q7d: non-page egress seen by our proxy from Q7c until after stagehand.close()");
console.log(proxy.log.filter((l) => !l.includes(site.url.replace(/\/$/, ""))));

await browser.close();
await chrome.kill();
await proxy.close();
await site.close();
