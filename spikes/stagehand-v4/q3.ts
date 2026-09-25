// Q3: After act(), can we identify the element acted on (selector / XPath / backend node id) and compute
// role, accessible name, label, placeholder, test id?
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { chromium, type Page as PwPage } from "playwright-core";
import { banner, createFakeLLM, findElementId, launchChromium, startSite } from "./lib.ts";

const site = await startSite();
const chrome = await launchChromium();
const browser = await localBrowser.connect({ cdpUrl: chrome.cdpUrl, extensionId: chrome.extensionId });

let target: { role: string; name: string; method: string; args: string[] } = { role: "button", name: "Add to cart", method: "click", args: [] };
const llm = createFakeLLM({
  act: (tree) => {
    const id = findElementId(tree, target.role, target.name);
    return id ? { elementId: id, method: target.method, arguments: target.args, description: `${target.role} ${target.name}` } : null;
  },
});
const stagehand = await Stagehand.create({ browser, model: llm.client, logging: { level: "warn" } });
const shPage = (await browser.context.activePage())!;
await shPage.goto(site.url, { waitUntil: "load" });

const pw = await chromium.connectOverCDP(chrome.cdpUrl);
const pwPage = pw.contexts()[0].pages().find((p) => p.url() === site.url)!;
const cdp = await pwPage.context().newCDPSession(pwPage);

async function describe(page: PwPage, selector: string) {
  // Playwright understands Stagehand's "xpath=/html[1]/body[1]/..." selectors natively.
  const loc = page.locator(selector);
  const dom = await loc.evaluate((el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    testId: el.getAttribute("data-testid"),
    placeholder: el.getAttribute("placeholder"),
    ariaLabel: el.getAttribute("aria-label"),
    labels: "labels" in el && (el as HTMLInputElement).labels ? Array.from((el as HTMLInputElement).labels!).map((l) => l.textContent?.trim()) : [],
    text: el.textContent?.trim() || null,
  }));
  // backendNodeId + computed role/name via CDP (Accessibility domain) on the same element.
  const xpath = selector.replace(/^xpath=/, "");
  const { result } = await cdp.send("Runtime.evaluate", { expression: `document.evaluate(${JSON.stringify(xpath)}, document, null, 9, null).singleNodeValue` });
  const { node } = await cdp.send("DOM.describeNode", { objectId: result.objectId! });
  const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { backendNodeId: node.backendNodeId, fetchRelatives: false });
  const ax = nodes[0];
  return { backendNodeId: node.backendNodeId, role: ax?.role?.value, accessibleName: ax?.name?.value, ...dom, ariaSnapshot: await loc.ariaSnapshot() };
}

for (const t of [
  { role: "button", name: "Add to cart", method: "click", args: [] as string[] },
  { role: "spinbutton", name: "Quantity", method: "fill", args: ["3"] },
]) {
  target = t;
  const before = llm.calls.length;
  const res = await stagehand.act(`${t.method} the ${t.name} ${t.role}`);
  banner(`Q3: act(${t.method} ${t.name})`);
  console.log("ActResult.data:", JSON.stringify(res.data, null, 1));
  console.log("ActResult.metadata:", JSON.stringify(res.metadata));
  const chosen = llm.calls.slice(before).find((c) => c.name === "Act")?.chosen as any;
  console.log("elementId the model chose (frameOrdinal-backendNodeId, seen by our ClientLLM):", chosen?.action?.elementId);
  const sel = res.data.actions[0]?.selector;
  console.log("derived element facts:", JSON.stringify(await describe(pwPage, sel), null, 1));
}

// Stagehand's public page.snapshot() exposes the same elementId -> xpath map the model sees.
const snap = await shPage.snapshot();
banner("Q3: page.snapshot()");
console.log("formattedTree (first lines):\n" + snap.formattedTree.split("\n").slice(0, 10).join("\n"));
console.log("xpathMap sample:", Object.entries(snap.xpathMap).slice(0, 6));

await pw.close();
await stagehand.close();
await browser.close();
await chrome.kill();
await site.close();
