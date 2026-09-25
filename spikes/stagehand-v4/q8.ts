// Q8: How is the model configured? Can we inject our own client so usage flows through our own LLM package?
// v4: Stagehand.create({ model }) accepts EITHER a provider ModelConfig { modelName, apiKey?, headers? }
// (inference runs inside the browser extension via the AI SDK) OR a ClientLLM { generate(request) } that
// Stagehand's in-browser runtime calls back over JSON-RPC ("llm.generate") -- i.e. OUR process does inference.
import { localBrowser, Stagehand, type ClientLLM } from "@browserbasehq/stagehand";
import { z } from "zod";
import { banner, findElementId, launchChromium, startSite } from "./lib.ts";

// ---- stand-in for our own packages/llm client ------------------------------------------------
interface OurLlmRequest { purpose: string; system?: string; prompt: string; jsonSchema?: unknown }
interface OurLlmResponse { json?: unknown; text?: string; model: string; usage: { input: number; output: number } }
const ledger: { purpose: string; model: string; input: number; output: number }[] = [];
const ourLlm = {
  async complete(req: OurLlmRequest): Promise<OurLlmResponse> {
    // Canned answers (no API key in this environment). A real impl would call Anthropic/OpenAI here.
    let json: unknown;
    if (req.purpose === "Act") json = { action: { elementId: findElementId(req.prompt, "button", "Add to cart"), description: "Add to cart", method: "click", arguments: [] }, twoStep: false };
    else if (req.purpose === "Observation") json = { elements: [{ elementId: findElementId(req.prompt, "button", "Add to cart"), description: "Add to cart", method: "click", arguments: [] }] };
    else if (req.purpose === "Extraction") json = { heading: /heading:\s*([^\n]+)/.exec(req.prompt)?.[1] ?? "" };
    else if (req.purpose === "Metadata") json = { progress: "done", completed: true };
    const res = { json, model: "claude-sonnet-4-5 (canned)", usage: { input: Math.ceil(((req.system ?? "") + req.prompt).length / 4), output: 30 } };
    ledger.push({ purpose: req.purpose, model: res.model, input: res.usage.input, output: res.usage.output });
    return res;
  },
};

// ---- adapter: our LLM package -> Stagehand ClientLLM ------------------------------------------
function toStagehandClientLLM(llm: typeof ourLlm): ClientLLM {
  return {
    async generate(request) {
      const rf = "responseFormat" in request ? request.responseFormat : undefined;
      const prompt = request.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content]))
        .map((c: any) => (c.type === "text" ? c.text : "")).join("\n");
      const purpose = rf?.type === "json_schema" ? rf.name : "text";
      const out = await llm.complete({ purpose, system: request.systemPrompt, prompt, jsonSchema: rf?.type === "json_schema" ? rf.schema : undefined });
      const usage = { inputTokens: out.usage.input, outputTokens: out.usage.output, totalTokens: out.usage.input + out.usage.output };
      return rf?.type === "json_schema"
        ? { role: "assistant", content: { type: "text", text: JSON.stringify(out.json) }, usage, outputFormat: "json_schema", structuredContent: out.json as any }
        : { role: "assistant", content: { type: "text", text: out.text ?? "" }, usage, outputFormat: "text" };
    },
  };
}

const site = await startSite();
const chrome = await launchChromium();
const browser = await localBrowser.connect({ cdpUrl: chrome.cdpUrl, extensionId: chrome.extensionId });
const stagehand = await Stagehand.create({ browser, model: toStagehandClientLLM(ourLlm), logging: { level: "warn" } });
const page = (await browser.context.activePage())!;
await page.goto(site.url, { waitUntil: "load" });

banner("Q8: act/observe/extract through our injected LLM client");
const o = await stagehand.observe("add to cart");
const a = await stagehand.act("click add to cart");
const e = await stagehand.extract("the heading", z.object({ heading: z.string() }));
console.log("observe  ->", JSON.stringify(o.data.map((x) => x.selector)), "usage", JSON.stringify(o.metadata.usage));
console.log("act      ->", a.data.success, "usage", JSON.stringify(a.metadata.usage));
console.log("extract  ->", JSON.stringify(e.data), "usage", JSON.stringify(e.metadata.usage));
console.log("our ledger (model name + usage recorded by OUR package):");
for (const l of ledger) console.log("  ", JSON.stringify(l));
console.log("stagehand.metrics().total* :", JSON.stringify(Object.fromEntries(Object.entries(await stagehand.metrics()).filter(([k]) => k.startsWith("total")))));

banner("Q8: per-call model override only accepts a provider ModelConfig (not a ClientLLM)");
try {
  // @ts-expect-error -- per-call `model` is ModelConfig only
  await stagehand.observe("x", { model: toStagehandClientLLM(ourLlm) });
} catch (err) { console.log("per-call ClientLLM rejected:", (err as Error).message.split("\n").slice(0, 3).join(" ").slice(0, 200)); }

await stagehand.close();
await browser.close();
await chrome.kill();
await site.close();
