// Q5: Does extract() accept a Zod schema (v4? v3?)? Does each call report model name and token usage?
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod"; // zod 4.x (package root)
import { z as z4 } from "zod/v4"; // explicit v4 subpath
import { z as z3 } from "zod/v3"; // zod 3 API shipped inside zod 4
import { banner, launchChromium, spikeShopLLM, startSite } from "./lib.ts";

const site = await startSite();
const chrome = await launchChromium();
const browser = await localBrowser.connect({ cdpUrl: chrome.cdpUrl, extensionId: chrome.extensionId });
const llm = spikeShopLLM();
const stagehand = await Stagehand.create({ browser, model: llm.client, logging: { level: "warn" } });
const shPage = (await browser.context.activePage())!;
await shPage.goto(site.url, { waitUntil: "load" });

async function tryExtract(label: string, fn: () => Promise<unknown>) {
  try {
    const r: any = await fn();
    console.log(`${label}: OK data=${JSON.stringify(r.data)} metadata=${JSON.stringify(r.metadata)}`);
  } catch (e) {
    console.log(`${label}: FAILED ${(e as Error).message.split("\n")[0]}`);
  }
}

banner("Q5: extract() with different schema flavours");
await tryExtract("zod (4.x root)", () => stagehand.extract("heading and cart count", z.object({ heading: z.string(), cartCount: z.number() })));
await tryExtract("zod/v4", () => stagehand.extract("heading and cart count", z4.object({ heading: z4.string(), cartCount: z4.number() })));
// @ts-expect-error -- v3 schemas are not assignable to Stagehand's z.ZodType (zod 4) parameter
await tryExtract("zod/v3", () => stagehand.extract("heading and cart count", z3.object({ heading: z3.string(), cartCount: z3.number() })));
await tryExtract("no schema (default {extraction:string})", () => stagehand.extract("heading", {}));

banner("Q5: what the ClientLLM received for extract (per LLM call)");
for (const c of llm.calls) console.log(`  ${c.name}: usage=${JSON.stringify(c.usage)}`);
console.log("NOTE: result.metadata has { usage, cache } only -- no model name field.");

banner("Q5: stagehand.metrics() (cumulative, per method)");
console.log(JSON.stringify(await stagehand.metrics()));

await stagehand.close();
await browser.close();
await chrome.kill();
await site.close();
