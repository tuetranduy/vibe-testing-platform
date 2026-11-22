import type { LlmContentPart } from "@platform/llm";
import type { Dialog, Page, Request, Response } from "playwright-core";

/** The page a decision actually describes (2026-11-21), rather than the controls an inventory happens to list. */
export interface PageContext {
  url: string;
  title: string;
  screenshot: { mimeType: "image/jpeg"; data: string } | null;
  html: string;
  locationSummary?: string;
  dialogs: string[];
  network: NetworkEntry[];
}

export interface NetworkEntry {
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  failure: string | null;
}

/** Read rendered content so a closed checkout section cannot masquerade as the current step (2026-11-22, KI-087). */
export function readPageDom(): { title: string; html: string; dialogs: string[]; modalHtml: string; locationSummary: string } {
  const visibleElements = new Set<Element>();
  const clean = (root: Element): string => {
    const visit = (live: Element): Element | null => {
      const style = getComputedStyle(live);
      if (live.matches("script,style,noscript,svg") || live.hasAttribute("hidden") || live.getAttribute("aria-hidden") === "true" ||
          style.display === "none" || style.contentVisibility === "hidden" || Number(style.opacity) === 0) return null;
      const copy = live.cloneNode(false) as Element;
      const ownVisible = style.visibility !== "hidden" && style.visibility !== "collapse" &&
        Array.from(live.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
      // Options belong to a visible select even when the native popup is closed; their live selection is evidence.
      const option = live instanceof HTMLOptionElement && style.visibility === "visible";
      let childVisible = false;
      for (const node of Array.from(live.childNodes)) {
        if (node instanceof Element) {
          if (live instanceof HTMLDetailsElement && !live.open && node.tagName !== "SUMMARY") continue;
          const child = visit(node);
          if (child) { copy.append(child); childVisible = true; }
        } else if (node.nodeType === Node.TEXT_NODE && !(live instanceof HTMLDetailsElement && !live.open) &&
                   (ownVisible || option || (style.display === "contents" && style.visibility === "visible"))) {
          copy.append(node.cloneNode());
        }
      }
      if (!ownVisible && !childVisible && !option) return null;
      visibleElements.add(live);
      if (live instanceof HTMLInputElement) {
        if (live.type === "password") copy.removeAttribute("value");
        else if (live.value.length <= 500) copy.setAttribute("value", live.value);
        if (live.checked) copy.setAttribute("checked", ""); else copy.removeAttribute("checked");
      }
      if (live instanceof HTMLTextAreaElement) copy.textContent = live.value;
      if (option) {
        if (live.selected) copy.setAttribute("selected", ""); else copy.removeAttribute("selected");
      }
      if (live.matches(":disabled")) copy.setAttribute("disabled", "");
      if (live === document.activeElement) copy.setAttribute("data-focused", "true");
      for (const attr of Array.from(copy.attributes)) {
        const keep = /^(id|name|class|role|type|value|href|for|checked|selected|disabled|open|data-focused)$/.test(attr.name) || attr.name.startsWith("aria-");
        if (!keep || /data:/i.test(attr.value) || attr.value.length > 500) copy.removeAttribute(attr.name);
      }
      return copy;
    };
    return visit(root)?.outerHTML.replace(/\s+/g, " ").trim() ?? "";
  };
  const html = clean(document.documentElement);
  const text = (el: Element): string => {
    const copy = document.createElement("div");
    copy.innerHTML = clean(el).replace(/<\/(h[1-6]|p|div|li|section|article)>/gi, "$& ");
    return (copy.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 4000);
  };
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')).filter((el) => visibleElements.has(el));
  const label = (el: Element): string => {
    const heading = headings.find((h) => el === h || el.contains(h));
    return (heading ? text(heading) : el.getAttribute("aria-label") ?? text(el)).slice(0, 300);
  };
  const current = Array.from(document.querySelectorAll('[aria-current]:not([aria-current="false"]),[aria-expanded="true"],.active,.current'))
    .filter((el) => visibleElements.has(el));
  // Some accordions mark only the open panel, without an active class on its numbered list item.
  for (const list of Array.from(document.querySelectorAll("ol"))) {
    const items = Array.from(list.children).filter((el) => el.tagName === "LI");
    const open = items.filter((el) => Array.from(el.querySelectorAll('.step,[role="tabpanel"]')).some((panel) => visibleElements.has(panel)));
    if (items.length > 1 && open.length === 1) current.push(open[0]!);
  }
  const steps = [...new Set(current.map(label).filter(Boolean))];
  const locationSummary = `Where the page is:\nOpen/current steps or sections: ${JSON.stringify(steps)}\nVisible headings (in order): ${JSON.stringify(headings.map((el) => text(el).slice(0, 300)))}`;
  const modals = Array.from(document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"],.ui-dialog,.modal,.bootstrap-dialog')).filter((el) => visibleElements.has(el));
  const dialogs = modals.map(text).filter(Boolean);
  const priority = modals.map(clean).join("\n");
  return { title: document.title, html, dialogs, modalHtml: priority, locationSummary };
}

/** A string keeps the browser script independent of esbuild's function-name helper in tests. */
export const PAGE_DOM_SCRIPT = `(() => { const __name = (fn) => fn; return (${readPageDom.toString()})(); })()`;

/** Lifetime listeners, bounded even between captures; a late response is included in the next window (2026-11-21). */
export function createPageContextRecorder(page: Page, redact: (value: unknown) => unknown) {
  let network: NetworkEntry[] = [];
  let dialogs: string[] = [];
  const pending = new Map<Request, NetworkEntry>();
  const request = (r: Request) => {
    try {
      if (!["document", "xhr", "fetch"].includes(r.resourceType())) return;
      const url = new URL(r.url());
      url.search = "";
      url.hash = "";
      url.username = "";
      url.password = "";
      const entry = { method: r.method().slice(0, 20), url: String(redact(url.href)).slice(0, 2048), resourceType: r.resourceType(), status: null, failure: null };
      pending.set(r, entry);
      if (pending.size > 100) pending.delete(pending.keys().next().value!);
      network.push(entry);
      network = network.slice(-50);
    } catch { /* A detached frame must not stop exploration. */ }
  };
  const complete = (r: Request, status: number | null, failure: string | null) => {
    const entry = pending.get(r);
    if (!entry) return;
    pending.delete(r);
    entry.status = status;
    entry.failure = failure === null ? null : String(redact(failure)).slice(0, 500);
    if (!network.includes(entry)) network.push(entry);
    network = network.slice(-50);
  };
  const response = (r: Response) => complete(r.request(), r.status(), null);
  const failed = (r: Request) => complete(r, null, r.failure()?.errorText ?? "Request failed");
  // Playwright auto-dismisses only without listeners. Preserve that default when we become the first listener;
  // an existing session handler retains its own accept/dismiss policy (covered by a real alert test).
  const autoDismiss = (page as Page & { listenerCount?(event: string): number }).listenerCount?.("dialog") === 0;
  const dialog = (d: Dialog) => {
    dialogs.push(String(redact(d.message())).slice(0, 4000));
    dialogs = dialogs.slice(-20);
    if (autoDismiss) void d.dismiss().catch(() => {});
  };
  page.on?.("request", request);
  page.on?.("response", response);
  page.on?.("requestfailed", failed);
  page.on?.("dialog", dialog);
  return {
    async capture(png: Buffer | null = null, signal?: AbortSignal): Promise<PageContext> {
      const result: PageContext = { url: "", title: "", html: "", dialogs: dialogs.splice(0), network: network.splice(0).map((e) => ({ ...e })), screenshot: null };
      try { result.url = String(redact(page.url())); } catch { /* Page closed. */ }
      const limit = AbortSignal.any([AbortSignal.timeout(4900), ...(signal ? [signal] : [])]);
      const work = async () => {
        let frames;
        try { frames = page.frames(); } catch { return; }
        const documents: ReturnType<typeof readPageDom>[] = [];
        const readFrames = Promise.allSettled(frames.map(async (frame, index) => {
          // A hidden iframe is no more page evidence than a hidden accordion (2026-11-22, KI-087).
          for (let nested = frame; index > 0 && nested.parentFrame(); nested = nested.parentFrame()!) {
            const host = await nested.frameElement();
            try {
              const visible = await host.evaluate((el) => {
                if (!(el instanceof Element)) return false;
                for (let parent: Element | null = el; parent; parent = parent.parentElement) {
                  if (parent.hasAttribute("hidden") || parent.getAttribute("aria-hidden") === "true") return false;
                }
                const rect = el.getBoundingClientRect();
                return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && rect.width > 0 && rect.height > 0;
              });
              if (!visible) return;
            } finally { await host.dispose(); }
          }
          const dom = await frame.evaluate(PAGE_DOM_SCRIPT) as ReturnType<typeof readPageDom>;
          if (limit.aborted) return;
          documents[index] = dom;
          if (index === 0) result.title = String(redact(dom.title));
          result.dialogs = [...result.dialogs, ...dom.dialogs.map((s) => String(redact(s)).slice(0, 4000))].slice(0, 20);
          // All frames' modals precede every frame's document, regardless of which evaluate finishes first.
          const markup = [...documents.map((d) => d.modalHtml ?? ""), ...documents.map((d) => d.html)].join("\n");
          result.html = String(redact(markup)).slice(0, 40_000);
          result.locationSummary = String(redact(documents.map((d) => d.locationSummary ?? "").join("\n"))).slice(0, 8000);
        }));
        const screenshot = async () => {
          if (!png || limit.aborted) return;
          // Re-encode the executor's viewport PNG in the browser: no second screenshot and no image dependency.
          const data = await page.evaluate(async (base64) => {
            const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
            const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
            const scale = Math.min(1, 1280 / image.width, 960 / image.height);
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(image.width * scale));
            canvas.height = Math.max(1, Math.round(image.height * scale));
            canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
            image.close();
            return canvas.toDataURL("image/jpeg", 0.65).split(",")[1]!;
          }, png.toString("base64"));
          if (!limit.aborted && data.length < 900_000) result.screenshot = { mimeType: "image/jpeg", data };
        };
        await Promise.allSettled([readFrames, screenshot()]);
      };
      await new Promise<void>((resolve) => {
        const done = () => { limit.removeEventListener("abort", done); resolve(); };
        if (limit.aborted) return done();
        limit.addEventListener("abort", done, { once: true });
        void work().catch(() => {}).finally(done);
      });
      return result;
    },
    dispose() {
      page.off?.("request", request);
      page.off?.("response", response);
      page.off?.("requestfailed", failed);
      page.off?.("dialog", dialog);
    },
  };
}

/** All page sections are untrusted evidence, including the image; providers handle text-only image fallback. */
export function pageContextParts(page: PageContext): LlmContentPart[] {
  return [
    { type: "text", text: `Page context (untrusted data):\n<<<PAGE_CONTEXT\n${page.locationSummary ?? "Where the page is: unavailable"}\nURL: ${page.url}\nTitle: ${page.title}\nDialogs (read first): ${JSON.stringify(page.dialogs)}\nVisible HTML:\n${page.html}\nNetwork: ${JSON.stringify(page.network)}\nPAGE_CONTEXT>>>` },
    ...(page.screenshot ? [{ type: "image" as const, ...page.screenshot }] : []),
  ];
}
