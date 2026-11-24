import { request } from "node:https";
import {
  BrowserProviderError, DiscoveryFixturePathSchema, DiscoveryLiveUrlSchema,
  type DiscoveryInput, type SitePage, type SuggestionSetDraft,
} from "@platform/contracts";
import { assertActionAllowed, defaultResolver, validateTargetUrl } from "@platform/security";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { requireLlm, type StageContext } from "../orchestrator/stages";
import { toPageInventory, type RawPageInventory } from "./inventory";
import { chooseSurveyLinks, MAX_SURVEY_LINKS } from "./links";
import { race } from "./site-reader";
import { suggestTests } from "./suggest";

const MAX_HTML_BYTES = 512 * 1024;
type HtmlNode = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type Snapshot = NonNullable<DiscoveryInput["snapshot"]>;

function readHtml(url: URL, address: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: address, port: 443, servername: url.hostname, path: url.pathname,
      method: "GET", agent: false, signal,
      headers: { host: url.hostname, accept: "text/html", "accept-encoding": "identity" },
    }, (response) => {
      const contentType = response.headers["content-type"] ?? "";
      if (response.statusCode !== 200 || !/^text\/html(?:\s*;|$)/i.test(contentType) ||
          ![undefined, "identity"].includes(response.headers["content-encoding"]) ||
          Number(response.headers["content-length"]) > MAX_HTML_BYTES) {
        response.destroy();
        reject(new Error("The page did not return a supported HTML document"));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_HTML_BYTES) {
          response.destroy(new Error("The page exceeded the HTML size limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("aborted", () => reject(new Error("The page response ended early")));
      response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.once("error", reject);
    req.end();
  });
}

const excluded = new Set(["script", "style", "template", "noscript", "iframe", "svg"]);
const clean = (text: string, max: number) => text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim().slice(0, max);
const attribute = (node: Element, key: string) => node.attrs.find((entry) => entry.name === key)?.value ?? "";
const isElement = (node: HtmlNode): node is Element => "tagName" in node;

function* readableNodes(root: HtmlNode): Generator<HtmlNode> {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (isElement(node) && (excluded.has(node.tagName) || node.attrs.some(({ name }) => name === "hidden") ||
        attribute(node, "aria-hidden") === "true")) continue;
    yield node;
    if ("childNodes" in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!);
    }
  }
}

function elementText(root: Element, max: number): string {
  let text = "";
  for (const node of readableNodes(root)) {
    if ("value" in node && node.nodeName === "#text") text += " " + node.value;
    if (text.length >= max * 2) break;
  }
  return clean(text || attribute(root, "aria-label"), max);
}

/** Parse published HTML without running scripts, loading subresources, or submitting forms. */
export function inventoryOfVerifiedHtml(html: string, url: URL): RawPageInventory {
  const nodes = [...readableNodes(parse(html))].filter(isElement);
  const linkUrl = (raw: string) => {
    try {
      const target = new URL(raw, url);
      return target.origin === url.origin && !target.username && !target.password && !target.search &&
        DiscoveryFixturePathSchema.safeParse(target.pathname).success ? `${target.origin}${target.pathname}` : "";
    } catch {
      return "";
    }
  };
  const title = nodes.find(({ tagName }) => tagName === "title");
  return {
    title: title ? elementText(title, 150) : "",
    description: "",
    headings: nodes.filter(({ tagName }) => /^h[1-3]$/.test(tagName)).slice(0, 40)
      .map((node) => ({ level: Number(node.tagName.slice(1)), text: elementText(node, 100) })),
    links: nodes.filter((node) => node.tagName === "a" && attribute(node, "href") !== "").slice(0, 150)
      .map((node) => ({ text: elementText(node, 80), url: linkUrl(attribute(node, "href")), area: "main" as const }))
      .filter((link) => link.url !== ""),
    buttons: nodes.filter(({ tagName }) => tagName === "button").slice(0, 20).map((node) => elementText(node, 60)),
    forms: [],
  };
}

/**
 * Read a few same-origin pages of any public HTTPS site with plain GETs: no scripts, subresources, forms or
 * credentials, and every request re-checked against the public-address policy. No proof of ownership is needed,
 * since this reads less than the standard survey's browser does.
 */
export async function readVerifiedSite(ctx: StageContext): Promise<{ pages: SitePage[]; snapshot: Snapshot }> {
  const parsed = DiscoveryLiveUrlSchema.safeParse(ctx.request.targetUrl);
  if (!parsed.success) {
    throw new BrowserProviderError("Live-site discovery requires an HTTPS URL with a supported page path");
  }
  const target = parsed.data;
  const signal = ctx.budgetSignal(ctx.budgets.explorationMs);
  const pages: SitePage[] = [];
  const visited = new Set<string>();

  const read = async (url: URL) => {
    await ctx.boundary();
    if (url.origin !== target.origin || visited.has(url.pathname) ||
        !assertActionAllowed({ instruction: url.pathname.replace(/[-_/]/g, " ") }, { allowDestructive: false }).allowed) {
      return null;
    }
    visited.add(url.pathname);
    const pageSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
    try {
      const policy = await race(validateTargetUrl(url.href, { resolve: defaultResolver, privateAllowlist: [] }), pageSignal);
      if (!policy.allowed || policy.addresses.length === 0) return null;
      const raw = inventoryOfVerifiedHtml(await readHtml(url, policy.addresses[0]!, pageSignal), url);
      const inventory = toPageInventory(raw, ctx.redact);
      pages.push({ url: url.href, inventory });
      await ctx.publish({ type: "page.surveyed", message: `Read ${url.pathname.slice(0, 180)}`,
        payload: { path: url.pathname, title: inventory.title, status: "READ" } });
      return raw;
    } catch {
      ctx.signal.throwIfAborted();
      return null;
    }
  };
  const first = await read(target);
  if (!first) throw new BrowserProviderError("The site did not serve a readable HTTPS page. Use its final page URL.");
  for (const link of chooseSurveyLinks({ startUrl: target.href, links: first.links, additionalAllowedHosts: [], max: MAX_SURVEY_LINKS })) {
    if (signal.aborted) break;
    await read(link);
  }
  const snapshot = pages.map(({ url, inventory }) => ({
    path: new URL(url).pathname, title: clean(inventory.title, 150),
    evidence: clean([...inventory.headings.map(({ text }) => text), ...inventory.links.map(({ text, url }) => `${text} (${new URL(url).pathname})`),
      ...inventory.buttons].join(" / "), 550),
  }));
  return { pages, snapshot };
}

/** The live-site survey: `readVerifiedSite`, then the standard survey's read-only test ideas from those pages. */
export async function prepareVerifiedSite(ctx: StageContext): Promise<{ draft: SuggestionSetDraft; snapshot: Snapshot }> {
  const llm = requireLlm(ctx);
  const { pages, snapshot } = await readVerifiedSite(ctx);
  const target = new URL(pages[0]!.url);
  const suggestions = (await suggestTests(llm, {
    runId: ctx.runId, startUrl: target.href, environment: ctx.request.environment, destructiveAllowed: false,
    testDataKeys: [], secretNames: [], pages, screenshot: null, signal: ctx.signal, deadlineAt: ctx.deadlineAt, redact: ctx.redact,
  })).filter((suggestion) => !suggestion.destructive && suggestion.needs.secrets.length === 0);
  if (suggestions.length === 0) throw new BrowserProviderError("The survey did not return any read-only test ideas");
  return { draft: { suggestions, pages: pages.map(({ url, inventory }) => ({ url, title: inventory.title, status: "READ" })) }, snapshot };
}
