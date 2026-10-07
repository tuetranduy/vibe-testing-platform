import type { PageInventory } from "@platform/contracts";
import { z } from "zod";

/** The model sees at most about this much of each page (JSON bytes). */
export const INVENTORY_MAX_BYTES = 6_000;

/** What the model is shown of one page. In contracts: the site analysis stores the pages read for the planner (KI-048). */
export { PageInventorySchema, type PageInventory } from "@platform/contracts";

/**
 * What INVENTORY_SCRIPT returns. It runs in the page's own world, where page scripts can tamper with
 * the builtins it uses, so the result is checked (typed and bounded) before anything reads it.
 */
const RawText = z.string().max(5_000).catch("");
const RawPageInventorySchema = z.object({
  title: RawText,
  description: RawText,
  headings: z.array(z.object({ level: z.number().int().min(1).max(3), text: RawText })).max(1_000).catch([]),
  links: z.array(z.object({ text: RawText, url: RawText, area: z.enum(["nav", "main"]).catch("main") })).max(1_000).catch([]),
  forms: z
    .array(
      z.object({
        name: RawText,
        fields: z.array(z.object({ label: RawText, type: RawText, placeholder: RawText })).max(100).catch([]),
        submit: RawText,
      }),
    )
    .max(100)
    .catch([]),
  buttons: z.array(RawText).max(1_000).catch([]),
});
export type RawPageInventory = z.infer<typeof RawPageInventorySchema>;

const EMPTY: RawPageInventory = { title: "", description: "", headings: [], links: [], forms: [], buttons: [] };

/** The checked result of INVENTORY_SCRIPT; anything malformed reads as an empty page. */
export function parseRawInventory(value: unknown): RawPageInventory {
  const r = RawPageInventorySchema.safeParse(value);
  return r.success ? r.data : EMPTY;
}

/**
 * Reads a page's inventory in the browser: `page.evaluate(INVENTORY_SCRIPT)`. A string, not a
 * function: the integration and live test projects transpile with esbuild's `keepNames`, which
 * wraps named functions — inner ones included — in a `__name(...)` call the page doesn't define
 * (README "Status"). It only reads the DOM (never an input's value) and caps what it returns.
 */
export const INVENTORY_SCRIPT = String.raw`(() => {
  const clean = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
  const textOf = (el, n) => clean(el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "", n);
  const inNav = (el) => Boolean(el.closest("header, nav, [role=navigation], [role=banner]"));
  const labelOf = (field) => {
    const byFor = field.id ? document.querySelector("label[for=\"" + CSS.escape(field.id) + "\"]") : null;
    const wrapping = field.closest("label");
    return clean((byFor && byFor.textContent) || (wrapping && wrapping.textContent) || field.getAttribute("aria-label") || field.getAttribute("name") || "", 80);
  };
  const meta = document.querySelector("meta[name=description]");
  const headings = Array.from(document.querySelectorAll("h1, h2, h3")).slice(0, 40)
    .map((h) => ({ level: Number(h.tagName.slice(1)), text: textOf(h, 150) }))
    .filter((h) => h.text);
  const links = Array.from(document.querySelectorAll("a[href]")).slice(0, 300)
    .map((a) => ({ text: textOf(a, 100), url: String(a.href), area: inNav(a) ? "nav" : "main" }));
  const submits = new Set();
  const forms = Array.from(document.forms).slice(0, 10).map((f) => {
    const submit = f.querySelector("button[type=submit], button:not([type]), input[type=submit]");
    if (submit) submits.add(submit);
    return {
      name: clean(f.getAttribute("aria-label") || f.getAttribute("name") || f.id || "", 80),
      fields: Array.from(f.querySelectorAll("input, select, textarea"))
        .filter((el) => !["hidden", "submit", "button", "reset", "image"].includes(el.type))
        .slice(0, 20)
        .map((el) => ({ label: labelOf(el), type: clean(el.type || el.tagName.toLowerCase(), 20), placeholder: clean(el.getAttribute("placeholder"), 80) })),
      submit: submit ? clean(submit.tagName === "INPUT" ? submit.getAttribute("value") : submit.innerText || submit.textContent, 60) : "",
    };
  });
  // A form's other buttons are listed too (demoqa's login form holds its "New User" type=button).
  const buttons = Array.from(document.querySelectorAll("button, [role=button], input[type=button]"))
    .filter((b) => !submits.has(b))
    .slice(0, 40)
    .map((b) => (b.tagName === "INPUT" ? clean(b.getAttribute("value"), 60) : textOf(b, 60)))
    .filter(Boolean);
  return { title: clean(document.title, 200), description: clean(meta ? meta.getAttribute("content") : "", 300), headings, links, forms, buttons };
})()`;

const clip = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);

/** A link as the model sees it: http(s) origin + path, no query or fragment (they can carry personal data). */
function modelUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? `${u.origin}${u.pathname}` : null;
  } catch {
    return null;
  }
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * The page inventory the model sees (spec section 5, step 2): secret values masked by the run
 * redactor first (masking may lengthen a text), then texts clipped, links reduced to http(s)
 * origin + path and de-duplicated, and the whole capped at INVENTORY_MAX_BYTES of JSON.
 */
export function toPageInventory(raw: RawPageInventory, redact: (value: unknown) => unknown): PageInventory {
  const r = redact(raw) as RawPageInventory;
  const seen = new Set<string>();
  const links: PageInventory["links"] = [];
  for (const l of r.links) {
    const url = modelUrl(l.url);
    const text = clip(l.text, 100);
    if (!url || seen.has(`${text}\n${url}`)) continue;
    seen.add(`${text}\n${url}`);
    links.push({ text, url, area: l.area });
    if (links.length >= 60) break;
  }
  return capInventory({
    title: clip(r.title, 200),
    description: clip(r.description, 300),
    headings: r.headings
      .slice(0, 40)
      .map((h) => ({ level: h.level as 1 | 2 | 3, text: clip(h.text, 150) }))
      .filter((h) => h.text !== ""),
    links,
    forms: r.forms.slice(0, 10).map((f) => ({
      name: clip(f.name, 80),
      fields: f.fields.slice(0, 20).map((x) => ({ label: clip(x.label, 80), type: clip(x.type, 20), placeholder: clip(x.placeholder, 80) })),
      submit: clip(f.submit, 60),
    })),
    buttons: r.buttons
      .map((b) => clip(b, 60))
      .filter((b) => b !== "")
      .slice(0, 40),
  });
}

/** Drops list items — from the end of whichever list is largest — until the inventory fits `maxBytes`. */
export function capInventory(inventory: PageInventory, maxBytes = INVENTORY_MAX_BYTES): PageInventory {
  const out: PageInventory = {
    ...inventory,
    headings: [...inventory.headings],
    links: [...inventory.links],
    forms: [...inventory.forms],
    buttons: [...inventory.buttons],
  };
  while (bytes(out) > maxBytes) {
    const sizes = [
      { list: "links", size: out.links.length > 0 ? bytes(out.links) : 0 },
      { list: "buttons", size: out.buttons.length > 0 ? bytes(out.buttons) : 0 },
      { list: "headings", size: out.headings.length > 0 ? bytes(out.headings) : 0 },
      { list: "forms", size: out.forms.length > 0 ? bytes(out.forms) : 0 },
    ] as const;
    const largest = [...sizes].sort((a, b) => b.size - a.size)[0]!;
    if (largest.size === 0) break;
    if (largest.list === "links") out.links.pop();
    else if (largest.list === "buttons") out.buttons.pop();
    else if (largest.list === "headings") out.headings.pop();
    else out.forms.pop();
  }
  return out;
}
