// Q1: Who launches the browser? Can WE launch Chromium (custom args: --proxy-server, fresh profile)
// and hand it to Stagehand via its CDP URL? Also verifies (Q7) that traffic goes through our proxy.
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { banner, launchChromium, spikeShopLLM, startLoggingProxy, startSite } from "./lib.ts";

const site = await startSite();
const proxy = await startLoggingProxy();

// Attempt A: our Chromium WITHOUT preloaded extension -> Stagehand tries CDP Extensions.loadUnpacked.
banner("Q1 attempt A: connect() and let Stagehand install its extension over CDP");
{
  const plain = await launchChromium({ proxyPort: proxy.port, preloadStagehandExtension: false });
  try {
    const b = await localBrowser.connect({ cdpUrl: plain.cdpUrl });
    console.log("attempt A connected:", b.provider, b.origin);
    await b.close();
  } catch (e) {
    console.log("attempt A FAILED:", (e as Error).message, JSON.stringify((e as any).cause));
  }
  await plain.kill();
}

// Attempt B: our Chromium with --load-extension=<stagehand runtime> and connect({ cdpUrl, extensionId }).
const chrome = await launchChromium({ proxyPort: proxy.port });
banner("Q1 attempt B: we launched Chromium ourselves (+ --load-extension)");
console.log("args:", chrome.args.filter((a) => /proxy|user-data-dir|remote-debugging|extension/.test(a)));
console.log("cdpUrl:", chrome.cdpUrl, "extensionId:", chrome.extensionId);

const browser = await localBrowser.connect({ cdpUrl: chrome.cdpUrl, extensionId: chrome.extensionId });
console.log("StagehandBrowser:", { provider: browser.provider, origin: browser.origin, sessionId: browser.sessionId });

const llm = spikeShopLLM();
const stagehand = await Stagehand.create({ browser, model: llm.client, logging: { level: "warn" } });
const page = (await browser.context.activePage()) ?? (await browser.context.newPage());
const resp = await page.goto(site.url, { waitUntil: "load" });
console.log("goto status:", resp?.status(), "title:", await page.title());

const obs = await stagehand.observe("find the add to cart button");
console.log("observe via our browser ->", obs.data.map((a) => a.selector));

banner("Q1/Q7: egress proxy log (requests Chromium sent via --proxy-server)");
for (const line of proxy.log) console.log("  proxy saw:", line);
console.log("site server hits:", site.hits);
const sawPage = proxy.log.some((l) => l.includes(site.url));
console.log("PROXY SAW PAGE REQUEST:", sawPage);

await stagehand.close();
await browser.close(); // for origin=connected + provider=local this sends CDP Browser.close
await chrome.kill();
await proxy.close();
await site.close();
if (!sawPage) process.exit(1);
