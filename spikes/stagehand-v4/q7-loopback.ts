// Q7 follow-up: Task 13 forces loopback through the egress proxy (--proxy-bypass-list=<-loopback>) and the
// proxy blocks non-public addresses. Stagehand's in-browser runtime opens a WebSocket from the extension
// service worker to the browser's OWN CDP endpoint (ws://127.0.0.1:<cdpPort>/devtools/browser/<id>).
//   A) proxy blocks the CDP port            -> does Stagehand still initialise?
//   B) proxy allows exactly 127.0.0.1:<cdpPort> and --remote-allow-origins=chrome-extension://<stagehandId>
//      -> Stagehand works, while a web page cannot open the CDP websocket.
//   C) same but --remote-allow-origins=*    -> a web page CAN open the CDP websocket (why B matters).
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { chromium } from "playwright-core";
import { banner, computeExtensionId, freePort, launchChromium, spikeShopLLM, startLoggingProxy, startSite, STAGEHAND_EXTENSION_DIR } from "./lib.ts";

const site = await startSite();
const sitePort = new URL(site.url).port;
const extId = computeExtensionId(STAGEHAND_EXTENSION_DIR);
console.log("computed Stagehand extension id:", extId);

async function scenario(label: string, allowCdp: boolean, allowOrigins: string) {
  banner(label);
  const cdpPort = await freePort();
  const proxy = await startLoggingProxy({
    // "privateAllowlist": only the site and (optionally) the CDP port are allowed on loopback.
    deny: (hp) => hp.startsWith("127.0.0.1:") && hp !== `127.0.0.1:${sitePort}` && !(allowCdp && hp === `127.0.0.1:${cdpPort}`),
  });
  const chrome = await launchChromium({ proxyPort: proxy.port, cdpPort, remoteAllowOrigins: allowOrigins });
  console.log("extensionId discovered:", chrome.extensionId, "| --remote-allow-origins:", allowOrigins);
  try {
    const browser = await localBrowser.connect({ cdpUrl: chrome.cdpUrl, extensionId: chrome.extensionId });
    const created = await Promise.race([
      Stagehand.create({ browser, model: spikeShopLLM().client, logging: { level: "off" } }).then((s) => ({ s })),
      new Promise<{ timeout: true }>((r) => setTimeout(() => r({ timeout: true }), 20000)),
    ]).catch((e) => ({ error: e as Error }));
    if ("s" in created) {
      const page = (await browser.context.activePage())!;
      await page.goto(site.url, { waitUntil: "load" });
      const obs = await created.s.observe("add to cart");
      console.log("Stagehand.create OK; observe ->", obs.data.map((a) => a.selector));
      const pw = await chromium.connectOverCDP(chrome.cdpUrl); // Node client: no Origin header -> allowed
      const pwPage = pw.contexts()[0].pages().find((p) => p.url() === site.url)!;
      const pageWs = await pwPage.evaluate((ws) => new Promise<string>((res) => {
        const s = new WebSocket(ws); s.onopen = () => { s.close(); res("OPEN (page can drive CDP!)"); }; s.onerror = () => res("REJECTED");
      }), chrome.wsUrl);
      console.log("Playwright connectOverCDP: OK | web page opening the CDP websocket:", pageWs);
      await pw.close();
      await created.s.close();
    } else if ("timeout" in created) console.log("Stagehand.create did not finish within 20s (hangs)");
    else console.log("Stagehand.create FAILED:", created.error.message.split("\n")[0].slice(0, 200));
  } catch (e) {
    console.log("connect FAILED:", (e as Error).message.split("\n")[0].slice(0, 200));
  }
  console.log("proxy decisions on loopback:", [...new Set(proxy.log.filter((l) => l.includes("127.0.0.1") && !l.includes(`:${sitePort}`)))]);
  await chrome.kill();
  await proxy.close();
}

await scenario("A: CDP port blocked by egress proxy", false, "*");
await scenario("B: CDP port allow-listed + remote-allow-origins restricted to the extension", true, `chrome-extension://${extId}`);
await scenario("C: CDP port allow-listed + remote-allow-origins=*", true, "*");
await site.close();
