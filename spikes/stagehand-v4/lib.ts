// Shared helpers for the Stagehand v4 capability spike.
// - startSite():          tiny static page (heading, labelled input, "Add to cart" button, counter badge)
// - startLoggingProxy():  minimal HTTP forward proxy that logs every request it sees
// - launchChromium():     WE launch Chromium (custom args, fresh profile, CDP port) -- no Stagehand involved
// - createFakeLLM():      a Stagehand ClientLLM ({ generate }) that answers with canned structured output
import http from "node:http";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClientLLM } from "@browserbasehq/stagehand";

export const CHROMIUM = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

export const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Spike Shop</title></head>
<body>
  <h1>Spike Shop</h1>
  <label for="qty">Quantity</label>
  <input id="qty" name="qty" type="number" placeholder="How many?" data-testid="qty-input" value="1">
  <button id="add" data-testid="add-to-cart" type="button">Add to cart</button>
  <span id="badge" data-testid="cart-count" role="status" aria-label="Cart items">0</span>
  <p id="price">loading price...</p>
  <script>
    document.getElementById('add').addEventListener('click', () => {
      const b = document.getElementById('badge');
      const q = parseInt(document.getElementById('qty').value || '1', 10) || 1;
      b.textContent = String(parseInt(b.textContent, 10) + q);
    });
    fetch('/api/price').then(r => r.json()).then(j => {
      document.getElementById('price').textContent = 'Price: ' + j.price;
    });
  </script>
</body></html>`;

export async function startSite(): Promise<{ url: string; close: () => Promise<void>; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === "/api/price") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ price: "CHF 10.00" }));
      return;
    }
    if (req.url === "/favicon.ico") { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE_HTML);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    hits,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** Minimal logging forward proxy (absolute-URI HTTP requests + CONNECT tunnels). */
export async function startLoggingProxy(opts: { deny?: (hostPort: string) => boolean } = {}): Promise<{ port: number; log: string[]; close: () => Promise<void> }> {
  const log: string[] = [];
  const server = http.createServer((req, res) => {
    let target: URL;
    try { target = new URL(req.url ?? ""); } catch { res.writeHead(400); res.end(); return; }
    if (opts.deny?.(`${target.hostname}:${target.port || 80}`)) { log.push(`DENIED HTTP ${req.method} ${req.url}`); res.writeHead(403); res.end(); return; }
    log.push(`HTTP ${req.method} ${req.url}`);
    const upstream = http.request(
      { host: target.hostname, port: target.port || 80, method: req.method, path: target.pathname + target.search, headers: req.headers },
      (up) => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res); },
    );
    upstream.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  server.on("connect", (req, clientSocket, head) => {
    if (opts.deny?.(req.url ?? "")) { log.push(`DENIED CONNECT ${req.url}`); clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    log.push(`CONNECT ${req.url}`);
    const [host, port] = (req.url ?? "").split(":");
    const upstream = net.connect(Number(port) || 443, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket); clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  return { port, log, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

export interface OwnChromium { cdpUrl: string; wsUrl: string; profileDir: string; proc: ChildProcess; args: string[]; extensionId?: string; kill: () => Promise<void> }

/** Stagehand v4's in-browser runtime (MV3 extension) shipped inside the npm package. */
export const STAGEHAND_EXTENSION_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "node_modules/@browserbasehq/stagehand/dist/extension",
);

/**
 * Launch Chromium OURSELVES with custom args + fresh profile and return its CDP endpoint.
 *
 * Stagehand v4 needs its runtime extension in the browser. Two ways:
 *  a) `--enable-unsafe-extension-debugging` and let Stagehand call CDP `Extensions.loadUnpacked`.
 *     On Chromium 141 (Playwright 1.56 build) this FAILS over a --remote-debugging-port websocket
 *     ("Method not available.").
 *  b) `--load-extension=<dir>` at launch (works on Chromium 141; open-source Chromium still honours
 *     the flag, branded Google Chrome >= 137 does not) and pass the extensionId to
 *     `localBrowser.connect({ cdpUrl, extensionId })`.  <-- used by default here.
 */
/** Chromium's id for an unpacked extension without a manifest "key": sha256(absolute path) -> a..p alphabet. */
export function computeExtensionId(dir: string): string {
  const hex = createHash("sha256").update(dir).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

export async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as net.AddressInfo;
  await new Promise((r) => srv.close(r));
  return port;
}

export async function launchChromium(opts: { proxyPort?: number; extraArgs?: string[]; preloadStagehandExtension?: boolean; cdpPort?: number; remoteAllowOrigins?: string; proxyBypassList?: string } = {}): Promise<OwnChromium> {
  const preload = opts.preloadStagehandExtension ?? true;
  const profileDir = await mkdtemp(path.join(tmpdir(), "spike-profile-"));
  const args = [
    "--headless=new",
    "--no-sandbox", // running as root in the sandbox container
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${opts.cdpPort ?? 0}`,
    `--remote-allow-origins=${opts.remoteAllowOrigins ?? "*"}`,
    "--enable-unsafe-extension-debugging",
    ...(opts.proxyPort ? [`--proxy-server=http://127.0.0.1:${opts.proxyPort}`, `--proxy-bypass-list=${opts.proxyBypassList ?? "<-loopback>"}`] : []),
    ...(preload ? [`--load-extension=${STAGEHAND_EXTENSION_DIR}`, `--disable-extensions-except=${STAGEHAND_EXTENSION_DIR}`] : []),
    ...(opts.extraArgs ?? []),
    "about:blank",
  ];
  const proc = spawn(CHROMIUM, args, { stdio: "ignore", detached: true });
  // Chromium writes the chosen port into <profile>/DevToolsActivePort.
  let port: number | undefined;
  for (let i = 0; i < 100 && port === undefined; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (opts.cdpPort) {
      try { if ((await fetch(`http://127.0.0.1:${opts.cdpPort}/json/version`)).ok) port = opts.cdpPort; } catch { /* not yet */ }
    } else {
      try { port = Number((await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8")).split("\n")[0]); } catch { /* not yet */ }
    }
  }
  if (!port) throw new Error("Chromium did not publish DevToolsActivePort");
  const cdpUrl = `http://127.0.0.1:${port}`;
  const version = (await (await fetch(`${cdpUrl}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  let extensionId: string | undefined;
  for (let i = 0; preload && i < 50 && !extensionId; i++) {
    const targets = (await (await fetch(`${cdpUrl}/json/list`)).json()) as { type: string; url: string }[];
    extensionId = targets.map((t) => /^chrome-extension:\/\/([a-p]{32})\/service-worker\.js/.exec(t.url)?.[1]).find(Boolean);
    if (!extensionId) await new Promise((r) => setTimeout(r, 100));
  }
  if (preload && !extensionId) throw new Error("Stagehand extension service worker not found");
  return {
    cdpUrl, wsUrl: version.webSocketDebuggerUrl, profileDir, proc, args, extensionId,
    kill: async () => {
      if (proc.exitCode === null && proc.pid) {
        const exited = new Promise((r) => proc.once("exit", r));
        try { process.kill(-proc.pid, "SIGKILL"); } catch { /* already gone */ }
        await exited;
      }
      await new Promise((r) => setTimeout(r, 200));
      await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Fake LLM: implements Stagehand's ClientLLM contract. Stagehand's in-browser runtime sends
// `llm.generate` JSON-RPC requests back to the SDK process, which calls `generate(request)`.
// We answer with canned JSON matching the requested responseFormat.name
// ("Act" | "Observation" | "Extraction" | "Metadata").
// ---------------------------------------------------------------------------------------------
type GenerateRequest = Parameters<ClientLLM["generate"]>[0];
type GenerateResult = Awaited<ReturnType<ClientLLM["generate"]>>;

export interface FakeLLMCall { name: string; systemPromptChars: number; userPromptChars: number; treeExcerpt: string[]; chosen?: unknown; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }

function promptText(req: GenerateRequest): string {
  return req.messages
    .map((m) => {
      const c = m.content as unknown;
      const parts = Array.isArray(c) ? c : [c];
      return parts.map((p: any) => (p?.type === "text" ? p.text : "")).join("\n");
    })
    .join("\n");
}

/** Find `[<frame>-<backendNodeId>] <role>: <name>` lines in Stagehand's serialized a11y tree. */
export function findElementId(tree: string, role: string, nameIncludes: string): string | undefined {
  const re = /\[(\d+-\d+)\]\s+([^:\n\[]+?)(?::\s*([^\n]*))?$/gm;
  for (const m of tree.matchAll(re)) {
    if (m[2].trim() === role && (m[3] ?? "").toLowerCase().includes(nameIncludes.toLowerCase())) return m[1];
  }
  return undefined;
}

export function createFakeLLM(opts: {
  act?: (tree: string) => { elementId?: string; method: string; arguments: string[]; description: string } | null;
  observe?: (tree: string) => { elementId?: string; method: string; arguments: string[]; description: string }[];
  extract?: (tree: string, schema: unknown) => unknown;
} = {}): { client: ClientLLM; calls: FakeLLMCall[] } {
  const calls: FakeLLMCall[] = [];
  const client: ClientLLM = {
    generate: async (req: GenerateRequest): Promise<GenerateResult> => {
      const text = promptText(req);
      const rf = (req as any).responseFormat as { type: string; name: string; schema: unknown } | undefined;
      const name = rf?.name ?? "text";
      const usage = { inputTokens: Math.ceil(text.length / 4), outputTokens: 42, totalTokens: Math.ceil(text.length / 4) + 42 };
      const call: FakeLLMCall = {
        name, usage,
        systemPromptChars: (req.systemPrompt ?? "").length,
        userPromptChars: text.length,
        treeExcerpt: text.split("\n").filter((l) => /\[\d+-\d+\]/.test(l)).slice(0, 12).map((l) => l.trim()),
      };
      calls.push(call);
      let structured: unknown;
      switch (name) {
        case "Act": {
          const a = opts.act?.(text) ?? null;
          structured = { action: a && a.elementId ? { elementId: a.elementId, description: a.description, method: a.method, arguments: a.arguments } : null, twoStep: false };
          break;
        }
        case "Observation":
          structured = { elements: (opts.observe?.(text) ?? []).filter((e) => e.elementId) };
          break;
        case "Extraction":
          structured = opts.extract?.(text, rf?.schema) ?? {};
          break;
        case "Metadata":
          structured = { progress: "extracted requested fields", completed: true };
          break;
        default:
          return { role: "assistant", content: { type: "text", text: "ok" }, outputFormat: "text", usage } as GenerateResult;
      }
      call.chosen = structured;
      return {
        role: "assistant",
        content: { type: "text", text: JSON.stringify(structured) },
        stopReason: "stop",
        usage,
        outputFormat: "json_schema",
        structuredContent: structured as any,
      } as GenerateResult;
    },
  };
  return { client, calls };
}

/** Default canned behaviour for the spike page. */
export function spikeShopLLM() {
  return createFakeLLM({
    act: (tree) => {
      const id = findElementId(tree, "button", "Add to cart");
      return id ? { elementId: id, method: "click", arguments: [], description: "Add to cart button" } : null;
    },
    observe: (tree) => [
      { elementId: findElementId(tree, "button", "Add to cart"), method: "click", arguments: [], description: "Add to cart button" },
      { elementId: findElementId(tree, "spinbutton", "Quantity"), method: "fill", arguments: ["3"], description: "Quantity input" },
    ],
    extract: (tree, schema) => {
      const heading = /heading:\s*([^\n]+)/.exec(tree)?.[1]?.trim() ?? "";
      if ((schema as any)?.properties?.extraction) return { extraction: heading };
      const count = /status:\s*[^\n]*?(\d+)\s*$/m.exec(tree)?.[1] ?? /Cart items[^\n]*\n\s*\[[^\]]+\]\s*StaticText:\s*(\d+)/.exec(tree)?.[1] ?? "0";
      return { heading, cartCount: Number(count) };
    },
  });
}

export function banner(title: string) {
  console.log(`\n===== ${title} =====`);
}
