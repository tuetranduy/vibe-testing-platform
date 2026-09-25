import { describe, expect, it } from "vitest";
import { checkMainFrameNavigation, computeAllowedHosts, isHostAllowed } from "./navigation-guard";

describe("computeAllowedHosts", () => {
  it("allows the target host, its subdomains and the additional hosts", () => {
    expect(computeAllowedHosts("https://Shop.Example.com:8443/path?q=1", ["cdn.partner.io", "PAY.example.net"])).toEqual([
      "shop.example.com",
      "*.shop.example.com",
      "cdn.partner.io",
      "pay.example.net",
    ]);
  });

  it("does not add a subdomain wildcard for IP-literal targets", () => {
    expect(computeAllowedHosts("http://127.0.0.1:4000/", [])).toEqual(["127.0.0.1"]);
    expect(computeAllowedHosts("http://[::1]:4000/", [])).toEqual(["::1"]);
  });

  it("de-duplicates", () => {
    expect(computeAllowedHosts("https://a.example/", ["a.example", "b.example", "b.example"])).toEqual([
      "a.example",
      "*.a.example",
      "b.example",
    ]);
  });
});

describe("isHostAllowed", () => {
  const allowed = ["shop.example.com", "*.shop.example.com", "cdn.partner.io"];

  it.each([
    ["shop.example.com", true],
    ["SHOP.example.com.", true],
    ["www.shop.example.com", true],
    ["a.b.shop.example.com", true],
    ["cdn.partner.io", true],
    ["img.cdn.partner.io", false], // additional hosts are exact
    ["example.com", false], // parent domain is not a subdomain
    ["evilshop.example.com", false], // suffix without a dot boundary
    ["shop.example.com.evil.io", false],
    ["", false],
  ])("%s → %s", (host, expected) => {
    expect(isHostAllowed(host, allowed)).toBe(expected);
  });
});

describe("checkMainFrameNavigation", () => {
  const policy = { allowedHosts: ["shop.test", "*.shop.test", "127.0.0.1"], privateAllowlist: ["127.0.0.1:4000", "shop.test:4000"] };

  it.each([
    "http://shop.test:4000/products",
    "https://www.shop.test/cart",
    "http://127.0.0.1:4000/", // allowlisted loopback target
    "about:blank",
    "about:srcdoc",
  ])("allows %s", (url) => {
    expect(checkMainFrameNavigation(url, policy)).toBeNull();
  });

  it.each([
    "https://example.org/",
    "http://cdn.test:9000/",
    "https://shop.test.evil.io/",
    "http://8.8.8.8/", // public IP literal, but not an allowed host
  ])("blocks %s as OFF_DOMAIN_NAVIGATION", (url) => {
    expect(checkMainFrameNavigation(url, policy)).toBe("OFF_DOMAIN_NAVIGATION");
  });

  it.each([
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://127.0.0.1:9222/json/version", // loopback on a port that is not allowlisted (e.g. CDP)
    "http://[::1]:4000/",
    "http://localhost:4000/",
    "http://app.localhost/",
    "http://2130706433/", // 127.0.0.1 in decimal
    "http://user:pass@shop.test:4000/",
    "file:///etc/passwd",
    "ftp://shop.test/file",
    "chrome://settings",
    "javascript:alert(1)",
    "data:text/html,<h1>x</h1>",
    "not a url",
  ])("blocks %s as TARGET_BLOCKED_BY_POLICY", (url) => {
    expect(checkMainFrameNavigation(url, policy)).toBe("TARGET_BLOCKED_BY_POLICY");
  });

  it("checks the address policy before the domain policy", () => {
    // 10.0.0.1 is neither allowed nor public: the policy reason wins over OFF_DOMAIN_NAVIGATION.
    expect(checkMainFrameNavigation("http://10.0.0.1:4000/", { allowedHosts: ["shop.test"], privateAllowlist: [] })).toBe(
      "TARGET_BLOCKED_BY_POLICY",
    );
  });

  it("an allowlisted private host:port still has to be an allowed host", () => {
    expect(checkMainFrameNavigation("http://demo-shop:4000/", { allowedHosts: ["shop.test"], privateAllowlist: ["demo-shop:4000"] })).toBe(
      "OFF_DOMAIN_NAVIGATION",
    );
  });
});
