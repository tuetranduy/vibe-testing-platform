import { describe, expect, it } from "vitest";
import { MAX_SURVEY_LINKS, chooseSurveyLinks, isAllowedPageHost, pageKey, surveyPageUrl, surveyPath, type SurveyLink } from "./links";

const START = "https://shop.example.com/";
const nav = (text: string, url: string): SurveyLink => ({ text, url, area: "nav" });
const main = (text: string, url: string): SurveyLink => ({ text, url, area: "main" });
const choose = (links: SurveyLink[], extra: { additionalAllowedHosts?: string[]; startAliases?: string[] } = {}) =>
  chooseSurveyLinks({ startUrl: START, links, additionalAllowedHosts: extra.additionalAllowedHosts ?? [], startAliases: extra.startAliases }).map(
    (u) => u.href,
  );

describe("chooseSurveyLinks", () => {
  it("takes navigation / header links first, then the rest, each in page order", () => {
    expect(
      choose([
        main("Pixel 11", "https://shop.example.com/products/2"),
        nav("Products", "https://shop.example.com/products"),
        main("iPhone 17 Pro", "https://shop.example.com/products/1"),
        nav("Cart", "https://shop.example.com/cart"),
      ]),
    ).toEqual([
      "https://shop.example.com/products",
      "https://shop.example.com/cart",
      "https://shop.example.com/products/2",
      "https://shop.example.com/products/1",
    ]);
  });

  it(`stops at ${MAX_SURVEY_LINKS} links`, () => {
    const many = Array.from({ length: 9 }, (_, i) => main(`Page ${i}`, `https://shop.example.com/p/${i}`));
    const chosen = choose(many);
    expect(chosen).toHaveLength(MAX_SURVEY_LINKS);
    expect(chosen.at(-1)).toBe("https://shop.example.com/p/4");
  });

  it("stays on the start URL's host or an additional allowed host (exactly), over http(s) only", () => {
    expect(
      choose(
        [
          main("Visit example.org", "https://example.org/"),
          main("Blog", "https://blog.shop.example.com/"),
          main("Login provider", "https://login.example.net/start"),
          main("Mail us", "mailto:shop@example.com"),
          main("Run", "javascript:alert(1)"),
          main("Call", "tel:+41000000"),
          main("Files", "ftp://shop.example.com/files"),
          main("Help", "https://shop.example.com/help"),
        ],
        { additionalAllowedHosts: ["login.example.net"] },
      ),
    ).toEqual(["https://login.example.net/start", "https://shop.example.com/help"]);
  });

  it("never picks the start page again, nor where it redirected to", () => {
    expect(
      choose(
        [
          nav("Home", "https://shop.example.com/"),
          nav("Top", "https://shop.example.com/#top"),
          nav("English", "https://shop.example.com/en/"),
          nav("Cart", "https://shop.example.com/cart"),
        ],
        { startAliases: ["https://shop.example.com/en"] },
      ),
    ).toEqual(["https://shop.example.com/cart"]);
  });

  it("loads one page per path: a fragment, a query or a trailing slash don't make another; the kept URL keeps its query", () => {
    expect(
      choose([
        main("Cart", "https://shop.example.com/cart#items"),
        main("Cart", "https://shop.example.com/cart/"),
        main("Cart", "https://shop.example.com/cart?ref=nav"),
        main("Search", "https://shop.example.com/products?q=pixel"),
      ]),
    ).toEqual(["https://shop.example.com/cart", "https://shop.example.com/products?q=pixel"]);
  });

  it.each(["catalog.pdf", "export.CSV", "photos.zip", "manual.docx", "banner.png", "promo.mp4", "song.mp3"])("skips a download (%s)", (file) => {
    expect(choose([main("Download", `https://shop.example.com/files/${file}`)])).toEqual([]);
  });

  it("keeps ordinary pages whose path has a dot", () => {
    expect(choose([main("About", "https://shop.example.com/about.html"), main("Legacy", "https://shop.example.com/index.php")])).toHaveLength(2);
  });

  it.each([
    ["Delete my account", "https://shop.example.com/account/remove-me"],
    ["Settings", "https://shop.example.com/account/delete"],
    ["Pay now", "https://shop.example.com/cart"],
    ["Continue", "https://shop.example.com/checkout?submit=1"],
    ["Unsubscribe", "https://shop.example.com/newsletter"],
  ])("skips a destructive link (%j → %s)", (text, url) => {
    expect(choose([main(text, url)])).toEqual([]);
  });

  it.each([
    ["Log out", "https://shop.example.com/session"],
    ["Sign off", "https://shop.example.com/bye"],
    ["Log-out", "https://shop.example.com/x"],
    ["Account", "https://shop.example.com/logout"],
    ["Account", "https://shop.example.com/users/sign_out"],
    ["Account", "https://shop.example.com/signout"],
  ])("skips a sign-out link (%j → %s)", (text, url) => {
    expect(choose([main(text, url)])).toEqual([]);
  });

  it("judges a link's path, not the site's host: a shop at pay.example.com is still surveyed", () => {
    expect(chooseSurveyLinks({ startUrl: "https://pay.example.com/", links: [main("Pricing", "https://pay.example.com/pricing")], additionalAllowedHosts: [] })).toHaveLength(1);
  });

  it("ignores links that are not URLs", () => {
    expect(choose([main("Broken", "http://")])).toEqual([]);
  });
});

describe("page identity and paths", () => {
  const start = new URL(START);

  it("keys a page by origin and path", () => {
    expect(pageKey(new URL("https://shop.example.com/cart/?a=1#b"))).toBe("https://shop.example.com/cart");
    expect(pageKey(new URL("https://shop.example.com"))).toBe("https://shop.example.com/");
  });

  it("shows a page's path — with its host only for another host — and never its query", () => {
    expect(surveyPath(new URL("https://shop.example.com/reset?email=alice@example.com"), start)).toBe("/reset");
    expect(surveyPath(new URL("https://login.example.net/start?next=/"), start)).toBe("login.example.net/start");
    expect(surveyPageUrl(new URL("https://shop.example.com/reset?email=alice@example.com#x"))).toBe("https://shop.example.com/reset");
  });

  it("lets a page end up on the start host, its subdomains or an additional host only", () => {
    expect(isAllowedPageHost(new URL("https://www.shop.example.com/"), start, [])).toBe(true);
    expect(isAllowedPageHost(new URL("https://login.example.net/"), start, ["login.example.net"])).toBe(true);
    expect(isAllowedPageHost(new URL("https://example.org/"), start, [])).toBe(false);
    expect(isAllowedPageHost(new URL("http://127.0.0.2:4000/"), new URL("http://127.0.0.1:4000/"), [])).toBe(false);
  });
});
