import { describe, expect, it } from "vitest";
import { defaultResolver, isHostPortAllowlisted, validateTargetUrl, type Resolver } from "./url-policy";

function fakeResolver(table: Record<string, string[]>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (hostname: string) => {
    calls.push(hostname);
    const hit = table[hostname];
    if (!hit) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return hit;
  }) as Resolver & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const table = {
  "example.com": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
  "public-name.test": ["10.0.0.5"],
  "multi.test": ["93.184.215.14", "10.0.0.5"],
  "v6-private.test": ["2606:4700::1111", "fd00::5"],
  "mapped.test": ["::ffff:127.0.0.1"],
  "empty.test": [],
  "localhost": ["93.184.215.14"], // a lying resolver must not matter for localhost
  "app.localhost": ["93.184.215.14"],
  "demo-shop": ["172.18.0.4"],
};

const opts = (privateAllowlist: string[] = []) => ({ resolve: fakeResolver(table), privateAllowlist });

describe("validateTargetUrl — rejects non-public targets", () => {
  it.each([
    "http://127.0.0.1",
    "http://localhost",
    "http://localhost.",
    "http://LOCALHOST:8080/admin",
    "http://app.localhost",
    "http://app.localhost.",
    "http://0.0.0.0",
    "http://2130706433",
    "http://0177.0.0.1",
    "http://0x7f.1",
    "http://127.1",
    "http://169.254.169.254",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1",
    "http://172.16.0.1",
    "http://192.168.1.10",
    "http://100.64.0.1",
    "http://[::1]",
    "http://[::ffff:127.0.0.1]",
    "http://[fd00::1]",
    "http://[fe80::1]",
    "http://[64:ff9b::a00:1]",
    "http://[::]",
    "http://224.0.0.1",
    "https://public-name.test",
    "https://public-name.test.",
    "https://multi.test",
    "https://v6-private.test",
    "https://mapped.test",
  ])("%s", async (url) => {
    const res = await validateTargetUrl(url, opts());
    expect(res.allowed).toBe(false);
    if (!res.allowed) expect(res.reason).toBe("NON_PUBLIC_ADDRESS");
  });

  it("does not consult DNS for localhost names", async () => {
    const o = opts();
    await validateTargetUrl("http://localhost", o);
    await validateTargetUrl("http://app.localhost", o);
    expect(o.resolve.calls).toEqual([]);
  });

  it("does not consult DNS for IP literals", async () => {
    const o = opts();
    await validateTargetUrl("http://10.0.0.1", o);
    await validateTargetUrl("http://8.8.8.8", o);
    expect(o.resolve.calls).toEqual([]);
  });

  it("names the offending address in detail", async () => {
    const res = await validateTargetUrl("https://multi.test", opts());
    expect(res).toMatchObject({ allowed: false, reason: "NON_PUBLIC_ADDRESS" });
    if (!res.allowed) expect(res.detail).toContain("10.0.0.5");
  });
});

describe("validateTargetUrl — other rejections", () => {
  it.each(["not a url", "", "http://", "//example.com"])("INVALID_URL: %j", async (url) => {
    const res = await validateTargetUrl(url, opts());
    expect(res).toMatchObject({ allowed: false, reason: "INVALID_URL" });
  });

  it.each([
    "file:///etc/passwd",
    "ftp://example.com",
    "javascript:alert(1)",
    "data:text/html,hi",
    "ws://example.com",
    "gopher://example.com",
  ])("UNSUPPORTED_PROTOCOL: %s", async (url) => {
    const res = await validateTargetUrl(url, opts());
    expect(res).toMatchObject({ allowed: false, reason: "UNSUPPORTED_PROTOCOL" });
  });

  it.each(["https://user:s3cretpw@example.com", "https://user@example.com", "https://:s3cretpw@example.com"])(
    "CREDENTIALS_IN_URL: %s",
    async (url) => {
      const res = await validateTargetUrl(url, opts());
      expect(res).toMatchObject({ allowed: false, reason: "CREDENTIALS_IN_URL" });
      if (!res.allowed) expect(res.detail).not.toContain("s3cretpw");
    },
  );

  it("DNS_RESOLUTION_FAILED when the resolver throws", async () => {
    const res = await validateTargetUrl("https://nxdomain.test", opts());
    expect(res).toMatchObject({ allowed: false, reason: "DNS_RESOLUTION_FAILED" });
  });

  it("DNS_RESOLUTION_FAILED when the resolver returns no addresses", async () => {
    const res = await validateTargetUrl("https://empty.test", opts());
    expect(res).toMatchObject({ allowed: false, reason: "DNS_RESOLUTION_FAILED" });
  });

  it("NON_PUBLIC_ADDRESS when the resolver returns garbage (fail closed)", async () => {
    const resolve: Resolver = async () => ["not-an-ip"];
    const res = await validateTargetUrl("https://weird.test", { resolve, privateAllowlist: [] });
    expect(res).toMatchObject({ allowed: false, reason: "NON_PUBLIC_ADDRESS" });
  });
});

describe("validateTargetUrl — allowed", () => {
  it("allows a hostname resolving only to public addresses", async () => {
    const o = opts();
    const res = await validateTargetUrl("https://example.com/shop?q=1", o);
    expect(res.allowed).toBe(true);
    if (res.allowed) {
      expect(res.host).toBe("example.com");
      expect(res.port).toBe(443);
      expect(res.addresses).toEqual(table["example.com"]);
      expect(res.url.href).toBe("https://example.com/shop?q=1");
    }
    expect(o.resolve.calls).toEqual(["example.com"]);
  });

  it("strips a trailing dot before resolving", async () => {
    const o = opts();
    const res = await validateTargetUrl("https://example.com./", o);
    expect(res).toMatchObject({ allowed: true, host: "example.com" });
    expect(o.resolve.calls).toEqual(["example.com"]);
  });

  it("infers port 80 for http and honours explicit ports", async () => {
    expect(await validateTargetUrl("http://example.com", opts())).toMatchObject({ allowed: true, port: 80 });
    expect(await validateTargetUrl("https://example.com:8443", opts())).toMatchObject({ allowed: true, port: 8443 });
  });

  it("allows public IP literals (v4 and v6) without DNS", async () => {
    expect(await validateTargetUrl("http://8.8.8.8", opts())).toMatchObject({
      allowed: true,
      host: "8.8.8.8",
      addresses: ["8.8.8.8"],
    });
    expect(await validateTargetUrl("http://[2606:4700:4700::1111]:8080", opts())).toMatchObject({
      allowed: true,
      host: "2606:4700:4700::1111",
      port: 8080,
      addresses: ["2606:4700:4700::1111"],
    });
  });
});

describe("validateTargetUrl — private allowlist", () => {
  it("allows demo-shop:4000 only when allowlisted, without resolving", async () => {
    const o = opts(["demo-shop:4000"]);
    const res = await validateTargetUrl("http://demo-shop:4000/products", o);
    expect(res).toMatchObject({ allowed: true, host: "demo-shop", port: 4000, addresses: [] });
    expect(o.resolve.calls).toEqual([]);
  });

  it("rejects demo-shop:4000 when not allowlisted", async () => {
    const res = await validateTargetUrl("http://demo-shop:4000", opts());
    expect(res).toMatchObject({ allowed: false, reason: "NON_PUBLIC_ADDRESS" });
  });

  it("rejects demo-shop:4001 even when demo-shop:4000 is allowlisted", async () => {
    const res = await validateTargetUrl("http://demo-shop:4001", opts(["demo-shop:4000"]));
    expect(res).toMatchObject({ allowed: false, reason: "NON_PUBLIC_ADDRESS" });
  });

  it("uses the scheme's default port for the allowlist match", async () => {
    expect(await validateTargetUrl("http://localhost", opts(["localhost:80"]))).toMatchObject({ allowed: true });
    expect(await validateTargetUrl("https://localhost", opts(["localhost:80"]))).toMatchObject({ allowed: false });
    expect(await validateTargetUrl("https://localhost", opts(["localhost:443"]))).toMatchObject({ allowed: true });
  });

  it("still rejects bad protocols and credentials for allowlisted hosts", async () => {
    expect(await validateTargetUrl("ftp://demo-shop:4000", opts(["demo-shop:4000"]))).toMatchObject({
      reason: "UNSUPPORTED_PROTOCOL",
    });
    expect(await validateTargetUrl("http://a:b@demo-shop:4000", opts(["demo-shop:4000"]))).toMatchObject({
      reason: "CREDENTIALS_IN_URL",
    });
  });
});

describe("isHostPortAllowlisted", () => {
  it("matches exact host:port, case-insensitively, ignoring trailing dots", () => {
    expect(isHostPortAllowlisted("demo-shop", 4000, ["demo-shop:4000"])).toBe(true);
    expect(isHostPortAllowlisted("DEMO-SHOP", 4000, ["demo-shop:4000"])).toBe(true);
    expect(isHostPortAllowlisted("demo-shop.", 4000, ["Demo-Shop:4000"])).toBe(true);
    expect(isHostPortAllowlisted("demo-shop", 4001, ["demo-shop:4000"])).toBe(false);
    expect(isHostPortAllowlisted("demo-shop", 4000, [])).toBe(false);
    expect(isHostPortAllowlisted("other", 4000, ["demo-shop:4000"])).toBe(false);
  });

  it("supports bracketed IPv6 entries and ignores malformed entries", () => {
    expect(isHostPortAllowlisted("::1", 8080, ["[::1]:8080"])).toBe(true);
    expect(isHostPortAllowlisted("[::1]", 8080, ["[::1]:8080"])).toBe(true);
    expect(isHostPortAllowlisted("demo-shop", 4000, ["demo-shop", "demo-shop:", ":4000", " "])).toBe(false);
  });

  it("trims whitespace around entries", () => {
    expect(isHostPortAllowlisted("demo-shop", 4000, [" demo-shop:4000 "])).toBe(true);
  });
});

describe("defaultResolver", () => {
  it("returns every address from the system resolver (hosts file, no network)", async () => {
    const addrs = await defaultResolver("localhost");
    expect(addrs.length).toBeGreaterThan(0);
    expect(addrs.some((a) => a === "127.0.0.1" || a === "::1")).toBe(true);
  });

  it("rejects for names that cannot be resolved", async () => {
    await expect(defaultResolver("definitely-not-a-real-host.invalid")).rejects.toThrow();
  });
});
