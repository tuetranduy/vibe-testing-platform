# Spike: Stagehand v4 capabilities (Task 0)

- **Date:** 2026-09-25
- **SDK tested:** `@browserbasehq/stagehand@4.1.0` (bundled runtime extension "Stagehand Runtime" 1.0.2). `latest` = 4.1.0; `v3-latest` = 3.7.3.
- **Environment:** Node 22.22.2, Chromium 141.0.7390.37 (`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, Playwright 1.56 build), `playwright-core@1.56.1`, `zod@4.4.3`, headless, no LLM or Browserbase API key.
- **Code:** `spikes/stagehand-v4/` is a standalone npm package, not part of the pnpm workspace. Run it with `npm install && npm run typecheck && ./run-all.sh`. The observed output of each script is in `spikes/stagehand-v4/output/<script>.txt`.

## How v4 works (differs from v3)

v4 is a thin Node SDK that sends JSON-RPC over CDP to an **MV3 extension running inside the browser**. The extension's service worker does the work: it takes accessibility snapshots, runs inference (AI SDK), performs actions, and handles caching and OTel. The extension then opens its own WebSocket from inside the browser to the browser's CDP endpoint (`browserCdpUrl`). Browsers come only from factories: `localBrowser.launch|connect` and `browserbase.launch|connect`. The resulting `StagehandBrowser` is branded, so a raw CDP connection cannot be passed in.

## Results

| # | Answer | Evidence (script → observed output) |
|---|---|---|
| Q1 Who launches the browser / can we launch it | **Yes.** We launch Chromium ourselves and hand it over with `localBrowser.connect({ cdpUrl, extensionId })`. `localBrowser.launch()` also accepts `executablePath`, `args`, `proxy {server,bypass}`, `userDataDir` and `headless`, but it **fails on Chromium 141** (see caveat 1). | `q1.ts`: attempt A (`connect({cdpUrl})` without the extension preloaded) failed with `Extensions.loadUnpacked: Method not available.` Attempt B (`--load-extension=<pkg>/dist/extension` + `connect({cdpUrl, extensionId})`) returned `provider: local, origin: connected`, and `goto` → 200, and `observe` returned selectors. |
| Q2 Playwright on the same page | **Yes.** | `q2.ts`: `chromium.connectOverCDP(cdpUrl)` sees the page Stagehand navigated to. Stagehand's `page.pageId` equals the CDP `targetId` (`equal: true`). A Playwright `page.route('**/api/price')` fulfilled the Stagehand-driven page's fetch ("CHF 0.99 (mocked by Playwright)"). `getByRole('button',{name:'Add to cart'}).count()` returned 1. After `stagehand.act` clicked, Playwright read badge = 1. After a Playwright fill + click, Stagehand's locator and `extract` read 6. |
| Q3 Identify the acted-on element | **Yes.** | `q3.ts`: `ActResult.data.actions[0].selector = "xpath=/html[1]/body[1]/button[1]"` (plus `method`, `arguments`, `description`). Our ClientLLM sees the model's `elementId` `"0-23"` (frameOrdinal-backendNodeId). From the XPath, Playwright and CDP give `backendNodeId: 23` (matches), `role: button`, `accessibleName: "Add to cart"`, `testId: add-to-cart`. For the input: `role: spinbutton`, `name: Quantity`, `labels: ["Quantity"]`, `placeholder: "How many?"`, `testId: qty-input`. `page.snapshot()` exposes `{formattedTree, xpathMap}` keyed by the same element ids. |
| Q4 observe() shape / act on it ourselves | **Yes.** | `q4.ts`: `{ data: Action[], metadata: { cache, usage } }` where `Action = { selector: "xpath=/html[1]/body[1]/button[1]", description, method?: "click"\|"fill"\|…, arguments?: string[] }`. The selector worked directly in Playwright `page.locator(sel)` and in Stagehand `page.locator(sel)`. `stagehand.act(action)` replays it deterministically: 0 LLM calls, zero usage. |
| Q5 extract() + Zod; model name / usage per call | **Partial.** Zod 4 schemas work. Zod 3 does not. Usage is reported per call. **No model name is reported.** | `q5.ts`: `zod` and `zod/v4` schemas returned typed data. `zod/v3` failed at runtime (`Cannot read properties of undefined (reading 'def')`) and is rejected by the types. With no schema, extract returns `{extraction: string}`. Every result has `metadata.usage {inputTokens, outputTokens, reasoningTokens, cachedInputTokens, inferenceTimeMs}`. `stagehand.metrics()` gives cumulative per-method totals. Extract makes 2 LLM calls ("Extraction" + "Metadata"). |
| Q6 Caching options / hit reported | **Partial.** The option is `cache: boolean \| { threshold?: number }` on `Stagehand.create` and on each act/observe/extract call. The status is reported per call in `metadata.cache {status: HIT\|MISS\|DISABLED, count?, threshold?, missReason?, tokensSaved?}`. Caching is **server-side on Browserbase only**, so it is always `DISABLED` with a local browser. | `q6.ts`: `cache: true` and `{threshold:1}` with a dummy `apiKey` gave `DISABLED` every time, and the LLM was called each time. The source (`buildCacheContext`) needs `apiKey` and a Browserbase `sessionId`. |
| Q7 Local Chromium mode | **Yes.** Browserbase is not needed. | `q1.ts`/`q7.ts`: fully local, no Browserbase key. The logging proxy saw `GET http://127.0.0.1:<site>/` and `/api/price` through `--proxy-server` + `--proxy-bypass-list=<-loopback>`. `q7-loopback.ts` and `q7-telemetry.ts` cover the proxy constraints (caveats 2–4). |
| Q8 Model config / inject our client | **Yes.** | `q8.ts`: `Stagehand.create({ model: { generate(req) } })` (ClientLLM). The in-browser runtime calls back to Node over RPC (`llm.generate`). observe, act and extract all ran through an adapter over "our LLM package". Our ledger recorded model name and usage per call, and the `usage` we returned appears in `metadata.usage` and `metrics()`. The per-call `model` option accepts only a provider `ModelConfig`; a ClientLLM there is rejected (invalid_union). |

### Caveats

What was verified live and what was read from the source:

- **Verified live, with real Chromium 141:** Q1–Q4, Q6, Q7 and Q8, plus Q5's schema handling and usage plumbing. All model responses came from a **fake ClientLLM** that returns canned structured output after parsing Stagehand's serialized a11y tree. Stagehand's snapshot, RPC, XPath resolution, action execution, usage aggregation and cache metadata were all real.
- **Not verified:** real model quality with Stagehand's prompts; two-step act; iframes and shadow DOM; Browserbase mode; server-side cache HITs (read from the extension source); `localBrowser.launch()` on a newer Chrome.
- **Read from the source (`dist/index.mjs`, `dist/extension/service-worker.js`):** provider `ModelConfig` inference runs **inside the browser** (AI SDK in the extension). Without an apiKey it falls back to the Browserbase Model Gateway, which needs a Browserbase session. `q7.ts` confirmed the first point: a dummy OpenAI key produced `CONNECT api.openai.com:443` at our proxy.

1. **Extension install on Chromium 141.** CDP `Extensions.loadUnpacked` is unavailable over `--remote-debugging-port`, so both `localBrowser.launch()` and `connect({cdpUrl})` without `extensionId` fail. The working pattern is to launch with `--load-extension=<dir> --disable-extensions-except=<dir>` and call `connect({ cdpUrl, extensionId })`. The id is deterministic: `sha256(absPath)[0..32]` mapped to `a–p`, and `computeExtensionId()` in `lib.ts` matched Chromium. Open-source Chromium still honours `--load-extension`; branded Google Chrome 137+ does not.
2. **The CDP loopback socket goes through the egress proxy.** With `<-loopback>`, the extension's WebSocket to `127.0.0.1:<cdpPort>` goes through our proxy.
   - `q7-loopback.ts` A: when the proxy blocks it, `Stagehand.create` fails with "CDP websocket failed to open".
   - B: allow-listing exactly `127.0.0.1:<cdpPort>` makes it work.
   - C shows the risk: with `--remote-allow-origins=*`, a **web page can open the browser CDP WebSocket** (`OPEN`).
   - B also shows the fix: with `--remote-allow-origins=chrome-extension://<stagehandId>`, the page's socket is `REJECTED`, while Stagehand and Playwright `connectOverCDP` still work, because Node clients send no Origin header.
3. **Telemetry defaults to `https://example.com/v1/traces`.** The extension exports OTel traces from inside the browser to that endpoint, and we saw `CONNECT example.com:443`. Setting `telemetry: { traces: { endpoint } }` redirects the export (`q7-telemetry.ts`: example.com was not seen, and the sink got `POST /v1/traces`). There is no option to turn it off.
4. **Chromium background egress.** Even with `--disable-background-networking`, the proxy saw clients2.google.com, accounts.google.com and content-autofill.googleapis.com. Add Stagehand's `DEFAULT_CHROME_FLAGS` (listed in `dist/index.mjs`) and deny these at the proxy.
5. **Zod versions must match.** Stagehand depends on `zod@4.4.3` exactly. A schema from `zod@4.6.5` works at runtime but fails the type check (TS2769, mismatched `$ZodType` internals). Pin the workspace to the same zod version (4.4.3) or dedupe it with a pnpm override.
6. The extension injects a content script (isolated world, `document_start`, all frames) and uses `chrome.debugger`. A page can detect this.
7. The SDK needs Node `>=22.18` (the repo root allows `>=22.12`).
8. `llm.generate` requests carry no call correlation id. Serialize act/observe/extract calls per Stagehand instance if usage must be attributed to steps.

## Decision: **GO**

Q1, Q2, Q3 and Q7 are all "yes", so the Go rule applies. We are not using the fallback. We will still act through Stagehand only while exploring. Replayable steps are recorded as our own Playwright locators computed from the acted element (Q3), not from Stagehand's positional XPaths. BrowserExplorer keeps the option open to switch to Playwright-only actions later.

## Implications for Tasks 10, 13, 14, 16

**Task 13 (browser sandbox):**
- Launch Chromium ourselves with:
  - `spawn(executablePath, [...])`, run detached, and kill the process group on close.
  - A fresh `mkdtemp` profile (`--user-data-dir`).
  - A fixed free `--remote-debugging-port=<p>`.
  - `--remote-allow-origins=chrome-extension://<computeExtensionId(extDir)>`. Never use `*`.
  - `--load-extension=<extDir> --disable-extensions-except=<extDir>`, where `extDir = <node_modules>/@browserbasehq/stagehand/dist/extension` (or `STAGEHAND_EXTENSION_DIRECTORY_PATH`).
  - `--proxy-server=<egress> --proxy-bypass-list=<-loopback>` plus the planned `--disable-quic` and WebRTC flags, and Stagehand's `DEFAULT_CHROME_FLAGS`.
  - `--headless=new`.
- The egress proxy's `privateAllowlist` must include `127.0.0.1:<cdpPort>`. Otherwise Stagehand cannot initialise.
- `SandboxedBrowser` exposes `{ cdpUrl, extensionId }`. Use Playwright `chromium.connectOverCDP(cdpUrl)` for `page.route`, the navigation guard and Playwright work.

**Task 14 (explorer adapter):**
- **Connect:**
  - `const browser = await localBrowser.connect({ cdpUrl, extensionId })`.
  - `const sh = await Stagehand.create({ browser, model: clientLLM, telemetry: { traces: { endpoint: <our OTel collector> } }, logging: { level: "warn", onLog }, selfHeal?, domSettleTimeoutMs?, systemPrompt? })`.
- **Pages:** `await browser.context.activePage()`, `.pages()`, `.newPage(url)`. The Stagehand `Page` has `goto`, `locator(sel)`, `evaluate`, `screenshot` and `snapshot()`. Map a Stagehand page to a Playwright page with `page.pageId === (await cdpSession.send("Target.getTargetInfo")).targetInfo.targetId`. Pass `{ page }` in the call options to target a non-active page.
- **observe:** `sh.observe(instruction?, { timeout?, variables?, locator?, ignoreLocators?, page?, cache? })` returns `{ data: Action[], metadata }`, where `Action = { selector: "xpath=/…", description, method?, arguments? }`. `sh.act(action)` replays an Action deterministically.
- **act:** `sh.act(instruction | Action, opts)` returns `{ data: { success, message, actionDescription, actions: Action[] }, metadata }`.
- **Facts about the acted element:**
  1. Resolve the XPath on the Playwright page.
  2. Get the `backendNodeId` with `DOM.describeNode`.
  3. Call `Accessibility.getPartialAXTree({ backendNodeId })` for role and name.
  4. Read the DOM for `labels`, `placeholder` and `data-testid`.
- **Metrics:** each call returns `metadata.usage {inputTokens, outputTokens, reasoningTokens, cachedInputTokens, inferenceTimeMs}` and `metadata.cache.status`. `sh.metrics()` returns cumulative `{act|extract|observe|total}{PromptTokens,CompletionTokens,ReasoningTokens,CachedInputTokens,InferenceTimeMs}`.
- **Caching:** Stagehand caching is unusable locally, so `llm.cacheHit` must come from our own cache. For example, key it by url + instruction + snapshot hash and replay with `sh.act(action)`, or have `@platform/llm` report its own prompt-cache hits.
- **Close:** `await sh.close()` first. Then either call `browser.close()` (sends `Browser.close`) or let the Task 13 sandbox kill its own process.

**Task 10 (`@platform/llm`):** implement Stagehand's `ClientLLM`: `{ generate(req): Promise<Result> }`.
- The request is `{ messages: {role:"user"|"assistant", content: Part | Part[]}[], systemPrompt?, temperature?, stopSequences?, responseFormat: { type:"json_schema", name, description?, schema /*JSON Schema*/ } }`, or a text variant with `tools?`, `toolChoice?` and `responseFormat?: {type:"text"}`.
- `Part` is one of: `{type:"text",text}`, `{type:"image",data(base64),mimeType}`, `tool_use`, `tool_result`.
- The result is `{ role:"assistant", content, stopReason?, usage?: {inputTokens, outputTokens, totalTokens, reasoningTokens?, cachedInputTokens?}, outputFormat:"json_schema", structuredContent }`, or `outputFormat:"text"`.
- `responseFormat.name` identifies the call: `"Act"`, `"Observation"`, `"Extraction"` or `"Metadata"`.
- Stagehand never reports the model name, so `@platform/llm` must record model, usage and cost itself.
- Do not use the provider `ModelConfig` path: it sends inference from inside the browser and bypasses `@platform/llm`.

**Task 16 (Playwright compiler):**
- Do not emit Stagehand XPaths (`/html[1]/body[1]/button[1]` is positional and brittle).
- Emit ranked locators from the Q3 facts: `getByTestId` > `getByRole(role, {name})` > `getByLabel` > `getByPlaceholder`.
- Playwright accepts `xpath=` selectors directly, so a raw XPath is available as a last resort.
