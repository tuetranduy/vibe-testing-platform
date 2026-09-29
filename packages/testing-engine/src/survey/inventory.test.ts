import { createRunRedactor } from "@platform/security";
import { describe, expect, it } from "vitest";
import { INVENTORY_MAX_BYTES, INVENTORY_SCRIPT, capInventory, parseRawInventory, toPageInventory, type RawPageInventory } from "./inventory";

const raw = (patch: Partial<RawPageInventory> = {}): RawPageInventory => ({
  title: "Your cart · Demo Shop",
  description: "",
  headings: [{ level: 1, text: "Your cart" }],
  links: [{ text: "Products", url: "https://shop.example.com/products?ref=nav#top", area: "nav" }],
  forms: [
    {
      name: "Log in",
      fields: [
        { label: "Email", type: "email", placeholder: "you@example.com" },
        { label: "Password", type: "password", placeholder: "" },
      ],
      submit: "Log in",
    },
  ],
  buttons: ["Empty cart"],
  ...patch,
});
const identity = (v: unknown) => v;
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

describe("toPageInventory", () => {
  it("keeps the page's structure: title, headings, links (area kept; no query or fragment), forms and buttons", () => {
    expect(toPageInventory(raw(), identity)).toEqual({
      title: "Your cart · Demo Shop",
      description: "",
      headings: [{ level: 1, text: "Your cart" }],
      links: [{ text: "Products", url: "https://shop.example.com/products", area: "nav" }],
      forms: [
        {
          name: "Log in",
          fields: [
            { label: "Email", type: "email", placeholder: "you@example.com" },
            { label: "Password", type: "password", placeholder: "" },
          ],
          submit: "Log in",
        },
      ],
      buttons: ["Empty cart"],
    });
  });

  it("masks the run's secret values wherever the page shows them", () => {
    const secret = "hunter2-Very-Secret";
    const inventory = toPageInventory(
      raw({ title: `Welcome back ${secret}`, headings: [{ level: 2, text: `Code ${secret}` }], buttons: [`Copy ${secret}`] }),
      createRunRedactor([secret]),
    );
    expect(JSON.stringify(inventory)).not.toContain(secret);
    expect(inventory.title).toBe("Welcome back [REDACTED]");
  });

  it("drops non-http(s) links and duplicates, and clips long texts", () => {
    const inventory = toPageInventory(
      raw({
        title: "t".repeat(500),
        links: [
          { text: "Mail", url: "mailto:a@example.com", area: "main" },
          { text: "Cart", url: "https://shop.example.com/cart", area: "main" },
          { text: "Cart", url: "https://shop.example.com/cart?x=1", area: "main" },
          { text: "x".repeat(300), url: "https://shop.example.com/long", area: "main" },
        ],
      }),
      identity,
    );
    expect(inventory.title).toHaveLength(200);
    expect(inventory.links.map((l) => l.url)).toEqual(["https://shop.example.com/cart", "https://shop.example.com/long"]);
    expect(inventory.links[1]!.text).toHaveLength(100);
  });

  it(`caps a page at about ${INVENTORY_MAX_BYTES} bytes, keeping its title and its first links`, () => {
    const links = Array.from({ length: 300 }, (_, i) => ({
      text: `Product number ${i} with a long descriptive name`,
      url: `https://shop.example.com/products/${i}`,
      area: (i < 5 ? "nav" : "main") as "nav" | "main",
    }));
    const buttons = Array.from({ length: 40 }, (_, i) => `Button ${i} with a label`);
    const inventory = toPageInventory(raw({ links, buttons }), identity);
    expect(bytes(inventory)).toBeLessThanOrEqual(INVENTORY_MAX_BYTES);
    expect(inventory.title).toBe("Your cart · Demo Shop");
    expect(inventory.links[0]!.url).toBe("https://shop.example.com/products/0");
    expect(inventory.links.length).toBeGreaterThan(10);
  });

  it("reads anything malformed from the page as an empty page", () => {
    for (const value of [null, "page", 42, { title: 7, links: "none" }]) {
      expect(toPageInventory(parseRawInventory(value), identity)).toMatchObject({ title: "", headings: [], links: [], forms: [], buttons: [] });
    }
  });
});

describe("capInventory", () => {
  it("leaves an inventory under the limit as it is", () => {
    const inventory = toPageInventory(raw(), identity);
    expect(capInventory(inventory)).toEqual(inventory);
  });
});

describe("INVENTORY_SCRIPT", () => {
  it("is one self-contained expression: no __name helper (esbuild keepNames), never an input's value", () => {
    expect(INVENTORY_SCRIPT).not.toContain("__name");
    expect(INVENTORY_SCRIPT).not.toContain(".value");
    // It parses; only a real page runs it (tests/integration/survey-stage.test.ts).
    expect(() => new Function(`return ${INVENTORY_SCRIPT};`)).not.toThrow();
  });
});
