// Q7 follow-up: Stagehand's in-browser runtime exports OTel traces to https://example.com/v1/traces by default
// (DEFAULT_TELEMETRY_CONFIG). Show that `telemetry.traces.endpoint` redirects it (here: to a local sink).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { banner, launchChromium, spikeShopLLM, startLoggingProxy, startSite } from "./lib.ts";

const site = await startSite();
const proxy = await startLoggingProxy();
const sinkHits: string[] = [];
const sink = http.createServer((req, res) => { sinkHits.push(`${req.method} ${req.url}`); req.resume(); res.writeHead(200); res.end("{}"); });
await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
const sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/v1/traces`;

const chrome = await launchChromium({ proxyPort: proxy.port });
const browser = await localBrowser.connect({ cdpUrl: chrome.cdpUrl, extensionId: chrome.extensionId });
const stagehand = await Stagehand.create({
  browser, model: spikeShopLLM().client, logging: { level: "error" },
  telemetry: { traces: { endpoint: sinkUrl, headers: { "x-spike": "1" } } },
});
const page = (await browser.context.activePage())!;
await page.goto(site.url, { waitUntil: "load" });
await stagehand.observe("add to cart");
await stagehand.close();
await new Promise((r) => setTimeout(r, 1500));

banner("Q7 telemetry: traces endpoint overridden");
console.log("example.com seen by proxy:", proxy.log.some((l) => l.includes("example.com")));
console.log("trace sink hits:", sinkHits);
console.log("proxy lines to the sink (trace export goes through the browser proxy too):", proxy.log.filter((l) => l.includes(sinkUrl.split("/v1")[0])));

await browser.close();
await chrome.kill();
await proxy.close();
await site.close();
sink.closeAllConnections(); sink.close();
