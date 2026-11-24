import { describe, expect, it } from "vitest";
import { inventoryOfVerifiedHtml } from "./verified-site";

describe("verified site inventory", () => {
  it("collects public page labels and links on the exact HTTPS origin without acting on markup", () => {
    const inventory = inventoryOfVerifiedHtml(`
      <title>Catalog</title><h1>Find books</h1><h2 hidden>Hidden heading</h2>
      <script>fetch("https://other.example/")</script>
      <a href="/books">Browse</a><a href="https://other.example/">Other</a>
      <a href="https://sub.catalog.example/">Subdomain</a><a href="http://catalog.example/">Downgrade</a>
      <a href="/books?private=true">Query</a><a href="/books#items">Jump</a>
      <form action="/submit"><input value="private"><button>Search</button></form>`,
      new URL("https://catalog.example/"),
    );
    expect(inventory).toMatchObject({
      title: "Catalog", headings: [{ level: 1, text: "Find books" }], buttons: ["Search"], forms: [],
      links: [
        { text: "Browse", url: "https://catalog.example/books" },
        { text: "Jump", url: "https://catalog.example/books" },
      ],
    });
    expect(JSON.stringify(inventory)).not.toContain("private");
  });
});
