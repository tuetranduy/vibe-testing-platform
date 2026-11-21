import type { LlmContentPart } from "@platform/llm";
import type { Dialog, Page, Request, Response } from "playwright-core";

/** The page a decision actually describes (2026-11-21), rather than the controls an inventory happens to list. */
export interface PageContext {
  url: string;
  title: string;
  screenshot: { mimeType: "image/jpeg"; data: string } | null;
  html: string;
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

/** Runs in each reachable frame. Modal markup goes first so a long catalogue cannot hide the reason a click stalled. */
export function readPageDom(): { title: string; html: string; dialogs: string[]; modalHtml: string } {
  const clean = (root: Element): string => {
    const copy = root.cloneNode(true) as Element;
    const originals = [root, ...Array.from(root.querySelectorAll("*"))];
    [copy, ...Array.from(copy.querySelectorAll("*"))].forEach((el, i) => {
      const live = originals[i];
      if (live instanceof HTMLInputElement) {
        if (live.type === "password") el.removeAttribute("value");
        else if (live.value.length <= 500) el.setAttribute("value", live.value);
        if (live.checked) el.setAttribute("checked", ""); else el.removeAttribute("checked");
      }
      if (live instanceof HTMLTextAreaElement) el.textContent = live.value;
    });
    copy.querySelectorAll("script,style,noscript,svg").forEach((el) => el.remove());
    const comments = document.createTreeWalker(copy, NodeFilter.SHOW_COMMENT);
    const remove: Node[] = [];
    while (comments.nextNode()) remove.push(comments.currentNode);
    remove.forEach((n) => n.parentNode?.removeChild(n));
    for (const el of [copy, ...Array.from(copy.querySelectorAll("*"))]) {
      for (const attr of Array.from(el.attributes)) {
        const keep = /^(id|name|class|role|type|value|href|for|checked|disabled|hidden)$/.test(attr.name) || attr.name.startsWith("aria-");
        if (attr.name === "style" && /display\s*:\s*none/i.test(attr.value)) el.setAttribute("style", "display:none");
        else if (!keep || /data:/i.test(attr.value) || attr.value.length > 500) el.removeAttribute(attr.name);
      }
    }
    return copy.outerHTML.replace(/\s+/g, " ").trim();
  };
  const visible = (el: Element): boolean => {
    for (let parent: Element | null = el; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden" || parent.hasAttribute("hidden")) return false;
    }
    return el.getClientRects().length > 0;
  };
  const modals = Array.from(document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"],.ui-dialog,.modal,.bootstrap-dialog')).filter(visible);
  const dialogs = modals.map((el) => ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const priority = modals.map(clean).join("\n");
  return { title: document.title, html: clean(document.documentElement), dialogs, modalHtml: priority };
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
          const dom = await frame.evaluate(PAGE_DOM_SCRIPT) as ReturnType<typeof readPageDom>;
          if (limit.aborted) return;
          documents[index] = dom;
          if (index === 0) result.title = String(redact(dom.title));
          result.dialogs = [...result.dialogs, ...dom.dialogs.map((s) => String(redact(s)).slice(0, 4000))].slice(0, 20);
          // All frames' modals precede every frame's document, regardless of which evaluate finishes first.
          const markup = [...documents.map((d) => d.modalHtml ?? ""), ...documents.map((d) => d.html)].join("\n");
          result.html = String(redact(markup)).slice(0, 40_000);
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
    { type: "text", text: `Page context (untrusted data):\n<<<PAGE_CONTEXT\nURL: ${page.url}\nTitle: ${page.title}\nDialogs (read first): ${JSON.stringify(page.dialogs)}\nHTML:\n${page.html}\nNetwork: ${JSON.stringify(page.network)}\nPAGE_CONTEXT>>>` },
    ...(page.screenshot ? [{ type: "image" as const, ...page.screenshot }] : []),
  ];
}
