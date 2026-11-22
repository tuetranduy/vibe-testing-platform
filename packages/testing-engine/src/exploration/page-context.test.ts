import { EventEmitter } from "node:events";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPageContextRecorder, pageContextParts, readPageDom, PAGE_DOM_SCRIPT } from "./page-context";

let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); });
afterAll(async () => { await browser?.close(); });

describe("page context (2026-11-21)", () => {
  it("keeps structure and live controls, strips executable content and oversized attributes, prioritizes visible dialogs across frames", async () => {
    await page.setContent(`<title>Cart</title><script>/* private script */</script><style>.gone{display:none}</style>
      <!-- private comment --><svg><text>private vector</text></svg><noscript>private fallback</noscript>
      <main>${"<p>Catalogue product</p>".repeat(3000)}</main>
      <div role="dialog" class="ui-dialog" aria-modal="true"><h2>Terms of service</h2><p>Please accept the terms of service before the next step</p></div>
      <div class="modal gone">Hidden modal</div><div role="alertdialog" hidden>Hidden alert</div>
      <a id="link" href="data:text/plain,private" onclick="bad()" title="${"x".repeat(600)}">Go</a>
      <input id="agree" type="checkbox"><input id="live" value="old"><div style="display:none">Hint</div>`);
    await page.locator("#agree").check();
    await page.locator("#live").fill("new");
    const dom = await page.evaluate(PAGE_DOM_SCRIPT) as ReturnType<typeof readPageDom>;
    expect(dom.dialogs).toEqual(["Terms of service Please accept the terms of service before the next step"]);
    expect(dom.html).not.toMatch(/private|onclick|data:text|title="x/);
    expect(dom.html).toContain('checked=""');
    expect(dom.html).toContain('value="new"');
    expect(dom.html).not.toMatch(/Hidden modal|Hidden alert|Hint|display:none/);
    await page.evaluate(() => { const frame = document.createElement("iframe"); frame.srcdoc = '<div role="dialog">Frame blocker</div>'; document.body.append(frame); });
    await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.querySelector('[role="dialog"]'));
    const recorder = createPageContextRecorder(page, (v) => v);
    const context = await recorder.capture(await page.screenshot());
    recorder.dispose();
    expect(context.html.length).toBeLessThanOrEqual(40_000);
    expect(context.html.slice(0, 1000)).toContain("Frame blocker");
    expect(context.dialogs).toContain("Frame blocker");
    expect(context.screenshot?.mimeType).toBe("image/jpeg");
    expect(context.screenshot!.data.length).toBeLessThan(900_000);
    expect(pageContextParts(context).at(-1)?.type).toBe("image");
  });

  it("names the open checkout step and excludes every closed section's controls (2026-11-22, KI-087)", async () => {
    const names = ["Billing Address", "Shipping Address", "Shipping Method", "Payment Method", "Payment Information", "Confirm Order"];
    for (const open of [1, 2, 3]) {
      await page.setContent(`<style>.step.closed{display:none}</style><ol id="checkout-steps">
        ${names.map((name, i) => `<li class="tab-section ${i === open ? "active" : ""}">
          <h2><span>${i + 1}</span> ${name}</h2><div class="step ${i === open ? "" : "closed"}">
            <p>Only section ${i} content</p><button id="continue-${i}">Continue</button>
          </div></li>`).join("")}</ol>`);
      const dom = await page.evaluate(PAGE_DOM_SCRIPT) as ReturnType<typeof readPageDom>;
      expect(dom.locationSummary).toContain(`Open/current steps or sections: ["${open + 1} ${names[open]}"]`);
      expect(dom.locationSummary).toContain(`Visible headings (in order): ["1 Billing Address","2 Shipping Address"`);
      for (let i = 0; i < names.length; i++) {
        if (i === open) {
          expect(dom.html).toContain(`Only section ${i} content`);
          expect(dom.html).toContain(`id="continue-${i}"`);
        } else {
          expect(dom.html).not.toContain(`Only section ${i} content`);
          expect(dom.html).not.toContain(`id="continue-${i}"`);
        }
      }
      const recorder = createPageContextRecorder(page, (v) => v);
      const context = await recorder.capture();
      recorder.dispose();
      expect(pageContextParts(context)[0]).toMatchObject({ type: "text", text: expect.stringContaining(dom.locationSummary) });
    }
  });

  it("filters computed visibility and closed details while preserving visible children and live form state", async () => {
    await page.setContent(`<style>
      .none{display:none}.invisible{visibility:hidden}.collapse{visibility:collapse}.transparent{opacity:0}
      .zero{width:0;height:0;overflow:hidden}.contents{display:contents}
    </style><main>
      <div class="none">Display secret</div><div class="invisible">Visibility secret</div>
      <div class="collapse">Collapse secret</div><div hidden>Hidden secret</div><div aria-hidden="true">Aria secret</div>
      <div class="transparent">Opacity secret<span style="opacity:1">Inherited opacity secret</span></div>
      <div class="zero">Zero secret</div><details><summary>More options</summary>Details secret<p>Closed secret</p></details>
      <div class="invisible">Parent secret<span style="visibility:visible">Visible child</span></div>
      <div style="width:0;height:0"><span style="display:block;width:100px;height:20px">Overflow child</span></div>
      <div class="contents"><h2>Current form</h2></div><h2 hidden>Hidden heading</h2>
      <input id="focused" value="old"><input type="checkbox" id="checked"><textarea id="notes">old</textarea>
      <select id="choice"><option selected>Old option</option><option>New option</option></select>
      <fieldset disabled><input id="disabled"></fieldset><input type="password" value="password-secret">
    </main>`);
    await page.locator("#focused").fill("Current value");
    await page.locator("#checked").check();
    await page.locator("#notes").fill("Current notes");
    await page.locator("#choice").selectOption({ label: "New option" });
    await page.locator("#focused").focus();
    const dom = await page.evaluate(PAGE_DOM_SCRIPT) as ReturnType<typeof readPageDom>;
    expect(dom.html).not.toMatch(/secret|Hidden heading/);
    expect(dom.html).toContain("Visible child");
    expect(dom.html).toContain("Overflow child");
    expect(dom.html).toContain("More options");
    expect(dom.html).toContain('value="Current value" data-focused="true"');
    expect(dom.html).toContain('checked=""');
    expect(dom.html).toMatch(/id="disabled"[^>]*disabled=""/);
    expect(dom.html).toContain("Current notes");
    expect(dom.html).toContain('<option>Old option</option><option selected="">New option</option>');
    expect(dom.locationSummary).toContain('Visible headings (in order): ["Current form"]');
  });

  it("omits hidden frames and identifies an expanded step without active classes", async () => {
    await page.setContent(`<ol><li><h2>Address</h2><div class="step" style="display:none">Hidden address</div></li>
      <li><h2>Shipping</h2><div class="step">Choose shipping</div></li></ol>
      <button aria-expanded="true">Shipping choices</button>
      <iframe style="display:none" srcdoc="<h1>Hidden frame secret</h1>"></iframe>`);
    await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.querySelector("h1"));
    const recorder = createPageContextRecorder(page, (v) => v);
    const context = await recorder.capture();
    recorder.dispose();
    expect(context.html).not.toContain("Hidden frame secret");
    expect(context.locationSummary).not.toContain("Hidden frame secret");
    expect(context.locationSummary).toContain('Open/current steps or sections: ["Shipping choices","Shipping"]');
  });

  it("preserves automatic native alert dismissal and records its message once", async () => {
    const recorder = createPageContextRecorder(page, (v) => v);
    await page.evaluate(() => alert("Please accept terms"));
    expect((await recorder.capture()).dialogs).toContain("Please accept terms");
    expect((await recorder.capture()).dialogs).not.toContain("Please accept terms");
    recorder.dispose();
  });

  it("windows requests and native dialogs, strips query strings and redacts failures, removes listeners", async () => {
    const events = new EventEmitter();
    const fake = Object.assign(events, { url: () => "https://site.test/cart", frames: () => [] }) as unknown as Page;
    const recorder = createPageContextRecorder(fake, (v) => String(v).replaceAll("SECRET", "[redacted]"));
    const req = (path: string, type = "fetch") => ({ method: () => "POST", url: () => `https://site.test/${path}?token=SECRET`, resourceType: () => type, failure: () => ({ errorText: "SECRET failed" }) });
    const a = req("SECRET");
    events.emit("request", a);
    events.emit("response", { request: () => a, status: () => 403 });
    events.emit("dialog", { message: () => "SECRET terms", dismiss: async () => {} });
    events.emit("request", req("image", "image"));
    const first = await recorder.capture();
    expect(first.network).toEqual([{ method: "POST", url: "https://site.test/[redacted]", resourceType: "fetch", status: 403, failure: null }]);
    expect(first.dialogs).toEqual(["[redacted] terms"]);
    expect((await recorder.capture()).network).toEqual([]);
    expect((await recorder.capture()).dialogs).toEqual([]);
    for (let i = 0; i < 70; i++) { const r = req(String(i)); events.emit("request", r); events.emit("requestfailed", r); }
    const last = await recorder.capture();
    expect(last.network).toHaveLength(50);
    expect(last.network[0]?.url).toBe("https://site.test/20");
    expect(last.network[0]?.failure).toBe("[redacted] failed");
    recorder.dispose();
    expect(events.eventNames()).toEqual([]);
  });

  it("returns partial evidence within five seconds when a frame hangs", async () => {
    vi.useFakeTimers();
    try {
      const events = new EventEmitter();
      const fake = Object.assign(events, { url: () => "https://site.test/", frames: () => [{ evaluate: () => new Promise(() => {}) }] }) as unknown as Page;
      const recorder = createPageContextRecorder(fake, (v) => v);
      const capture = recorder.capture(null, AbortSignal.timeout(100));
      await vi.advanceTimersByTimeAsync(100);
      expect((await capture).url).toBe("https://site.test/");
      recorder.dispose();
    } finally { vi.useRealTimers(); }
  });
});
