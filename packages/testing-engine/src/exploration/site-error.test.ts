import { describe, expect, it } from "vitest";
import { siteErrorOf } from "./site-error";

const page = (over: Partial<{ title: string; headings: string[]; text: string }> = {}) => ({ title: "Shop", headings: [], text: "", ...over });

describe("siteErrorOf (KI-074)", () => {
  it("a server error title or heading", () => {
    expect(siteErrorOf(page({ title: "500 | Internal Server Error" }))).toBe("500 | Internal Server Error");
    expect(siteErrorOf(page({ headings: ["Something went wrong"] }))).toBe("Something went wrong");
    expect(siteErrorOf(page({ headings: ["503 Service Unavailable"] }))).toBe("503 Service Unavailable");
    expect(siteErrorOf(page({ title: "Error 502", headings: [] }))).toBe("Error 502");
    expect(siteErrorOf(page({ headings: ["500"] }))).toBe("500");
    expect(siteErrorOf(page({ title: "502 - Bad Gateway" }))).toBe("502 - Bad Gateway");
  });

  it("a short page that is only an error message", () => {
    const text = '500\n[PATCH] "https://demo-frontends.shopware.store/store-api/context": <no response> Failed to fetch\nAn error occurred';
    expect(siteErrorOf(page({ text }))).toBe("An error occurred");
  });

  it("does not flag a page that only mentions errors", () => {
    expect(siteErrorOf(page({ headings: ["Common errors when ordering"] }))).toBeNull();
    expect(siteErrorOf(page({ headings: ["Page not found"], title: "404" }))).toBeNull();
    expect(siteErrorOf(page({ headings: ["Fred - 3 Burner Gas Grill"], text: `${"A grill. ".repeat(60)} If something went wrong with your order, call us.` }))).toBeNull();
    expect(siteErrorOf(page({ headings: ["Orders over $500"] }))).toBeNull();
    // An error panel inside a working page: a later heading, or a long page (review finding).
    expect(siteErrorOf(page({ headings: ["Checkout", "Something went wrong"], text: "Checkout\nSomething went wrong" }))).toBeNull();
    expect(siteErrorOf(page({ headings: ["Something went wrong"], text: `Something went wrong\n${"Your basket. ".repeat(60)}` }))).toBeNull();
    // A product whose name starts with a number in the 500s (review finding, 2026-11-19).
    expect(siteErrorOf(page({ title: "500 GB SSD | Shop", headings: ["500 GB SSD"] }))).toBeNull();
    expect(siteErrorOf(page({ headings: ["503 Bike Pro"] }))).toBeNull();
    expect(siteErrorOf(page({ text: "512 MB RAM stick\nIn stock" }))).toBeNull();
  });
});
