import http from "node:http";
import net from "node:net";
import type { Resolver } from "@platform/security";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startEgressProxy, type EgressBlockEvent, type EgressProxy } from "./egress-proxy";

const PUBLIC_IP = "93.184.216.34";
const OTHER_PUBLIC_IP = "93.184.216.35";

interface Upstream {
  port: number;
  seen: { method: string; url: string; headers: http.IncomingHttpHeaders }[];
  close(): Promise<void>;
}

/** Local HTTP server that echoes what it received; also echoes raw bytes for tunnels that don't speak HTTP. */
async function startUpstream(): Promise<Upstream> {
  const seen: Upstream["seen"] = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    res.writeHead(200, { "content-type": "text/plain", "x-upstream": "yes" });
    res.end(`hello from upstream ${req.url}`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    seen,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Plain TCP echo server (stands in for a TLS origin behind CONNECT). */
async function startEcho(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => {});
    s.pipe(s);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/** Fake resolver from a table; records every lookup. Unknown names fail like ENOTFOUND. */
function fakeResolver(table: Record<string, string[] | (() => string[])>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (host: string) => {
    calls.push(host);
    const entry = table[host];
    if (entry === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return typeof entry === "function" ? entry() : entry;
  }) as Resolver & { calls: string[] };
  fn.calls = calls;
  return fn;
}

interface ProxyResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function forward(proxy: EgressProxy, absoluteUrl: string, headers: Record<string, string> = {}): Promise<ProxyResponse> {
  const { port } = new URL(proxy.url);
  const target = new URL(absoluteUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: Number(port), method: "GET", path: absoluteUrl, headers: { host: target.host, ...headers }, agent: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Sends a raw CONNECT; resolves with the status code and the (still open) socket. */
function connectVia(proxy: EgressProxy, authority: string): Promise<{ status: number; socket: net.Socket }> {
  const { port } = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), "127.0.0.1");
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buf)?.[1] ?? 0);
      const rest = buf.slice(end + 4);
      if (rest) socket.unshift(Buffer.from(rest, "latin1"));
      resolve({ status, socket });
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
  });
}

function echoRoundTrip(socket: net.Socket, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let got = "";
    socket.on("data", (c: Buffer) => {
      got += c.toString("utf8");
      if (got.length >= text.length) resolve(got);
    });
    socket.on("error", reject);
    socket.write(text);
  });
}

describe("egress proxy", () => {
  let upstream: Upstream;
  let echo: { port: number; close(): Promise<void> };
  let proxy: EgressProxy | undefined;
  let blocks: EgressBlockEvent[];
  let dials: [string, number][];

  /** Dial seam: records the address the proxy chose and routes it to a local server instead of the internet. */
  const dialTo = (localPort: () => number) => (address: string, port: number) => {
    dials.push([address, port]);
    return net.connect(localPort(), "127.0.0.1");
  };

  beforeEach(async () => {
    upstream = await startUpstream();
    echo = await startEcho();
    blocks = [];
    dials = [];
  });

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
    await upstream.close();
    await echo.close();
  });

  describe("public destinations", () => {
    it("forwards a plain HTTP request to the vetted public address", async () => {
      const resolve = fakeResolver({ "shop.example": [PUBLIC_IP] });
      proxy = await startEgressProxy({ resolve, privateAllowlist: [], onBlock: (e) => blocks.push(e), dial: dialTo(() => upstream.port) });

      const res = await forward(proxy, "http://shop.example/hello?x=1", {
        "proxy-authorization": "Basic c2VjcmV0",
        "proxy-connection": "keep-alive",
      });

      expect(res.status).toBe(200);
      expect(res.body).toBe("hello from upstream /hello?x=1");
      expect(dials).toEqual([[PUBLIC_IP, 80]]);
      expect(upstream.seen).toHaveLength(1);
      expect(upstream.seen[0]?.url).toBe("/hello?x=1");
      expect(upstream.seen[0]?.headers.host).toBe("shop.example");
      expect(upstream.seen[0]?.headers["proxy-authorization"]).toBeUndefined();
      expect(upstream.seen[0]?.headers["proxy-connection"]).toBeUndefined();
      expect(blocks).toEqual([]);
    });

    it("tunnels an HTTPS CONNECT to the vetted public address", async () => {
      const resolve = fakeResolver({ "shop.example": [PUBLIC_IP] });
      proxy = await startEgressProxy({ resolve, privateAllowlist: [], onBlock: (e) => blocks.push(e), dial: dialTo(() => echo.port) });

      const { status, socket } = await connectVia(proxy, "shop.example:443");
      expect(status).toBe(200);
      expect(await echoRoundTrip(socket, "ping-through-tunnel")).toBe("ping-through-tunnel");
      socket.destroy();

      expect(dials).toEqual([[PUBLIC_IP, 443]]);
      expect(blocks).toEqual([]);
    });

    it("falls back to the next vetted address when the first one refuses", async () => {
      const resolve = fakeResolver({ "shop.example": [PUBLIC_IP, OTHER_PUBLIC_IP] });
      proxy = await startEgressProxy({
        resolve,
        privateAllowlist: [],
        onBlock: (e) => blocks.push(e),
        dial: (address, port) => {
          dials.push([address, port]);
          // First address: a closed port (connection refused); second: the echo server.
          return net.connect(address === PUBLIC_IP ? 1 : echo.port, "127.0.0.1");
        },
      });

      const { status, socket } = await connectVia(proxy, "shop.example:443");
      expect(status).toBe(200);
      expect(await echoRoundTrip(socket, "second")).toBe("second");
      socket.destroy();
      expect(dials).toEqual([
        [PUBLIC_IP, 443],
        [OTHER_PUBLIC_IP, 443],
      ]);
      expect(resolve.calls).toEqual(["shop.example"]);
    });
  });

  describe("non-public destinations", () => {
    it.each([
      ["a private address", ["10.0.0.5"]],
      ["a loopback address", ["127.0.0.1"]],
      ["a link-local (metadata) address", ["169.254.169.254"]],
      ["a mix of public and private addresses", [PUBLIC_IP, "192.168.1.10"]],
      ["an IPv4-mapped IPv6 loopback address", ["::ffff:127.0.0.1"]],
    ])("blocks HTTP and CONNECT to a hostname resolving to %s with 403", async (_label, addrs) => {
      const resolve = fakeResolver({ "internal.example": addrs });
      proxy = await startEgressProxy({ resolve, privateAllowlist: [], onBlock: (e) => blocks.push(e), dial: dialTo(() => upstream.port) });

      const res = await forward(proxy, "http://internal.example/secret");
      expect(res.status).toBe(403);
      const { status, socket } = await connectVia(proxy, "internal.example:443");
      socket.destroy();
      expect(status).toBe(403);

      expect(dials).toEqual([]);
      expect(upstream.seen).toEqual([]);
      expect(blocks).toEqual([
        { host: "internal.example", port: 80, reason: "NON_PUBLIC_ADDRESS" },
        { host: "internal.example", port: 443, reason: "NON_PUBLIC_ADDRESS" },
      ]);
    });

    it("blocks non-public IP literals without resolving them", async () => {
      const resolve = fakeResolver({});
      proxy = await startEgressProxy({ resolve, privateAllowlist: [], onBlock: (e) => blocks.push(e), dial: dialTo(() => upstream.port) });

      expect((await forward(proxy, "http://169.254.169.254/latest")).status).toBe(403);
      const v6 = await connectVia(proxy, "[::1]:443");
      v6.socket.destroy();
      expect(v6.status).toBe(403);

      expect(resolve.calls).toEqual([]);
      expect(dials).toEqual([]);
      expect(blocks).toEqual([
        { host: "169.254.169.254", port: 80, reason: "NON_PUBLIC_ADDRESS" },
        { host: "::1", port: 443, reason: "NON_PUBLIC_ADDRESS" },
      ]);
    });

    it("blocks localhost names without resolving them", async () => {
      const resolve = fakeResolver({ localhost: ["127.0.0.1"] });
      proxy = await startEgressProxy({ resolve, privateAllowlist: [], onBlock: (e) => blocks.push(e), dial: dialTo(() => upstream.port) });

      expect((await forward(proxy, "http://localhost:8080/")).status).toBe(403);
      expect(resolve.calls).toEqual([]);
      expect(blocks).toEqual([{ host: "localhost", port: 8080, reason: "NON_PUBLIC_ADDRESS" }]);
    });

    it("blocks when DNS resolution fails", async () => {
      const resolve = fakeResolver({});
      proxy = await startEgressProxy({ resolve, privateAllowlist: [], onBlock: (e) => blocks.push(e), dial: dialTo(() => upstream.port) });

      const { status, socket } = await connectVia(proxy, "nowhere.example:443");
      socket.destroy();
      expect(status).toBe(403);
      expect(dials).toEqual([]);
      expect(blocks).toEqual([{ host: "nowhere.example", port: 443, reason: "DNS_RESOLUTION_FAILED" }]);
    });
  });

  describe("DNS rebinding", () => {
    /** Public on the first lookup, private on every later one. */
    const rebinding = () => {
      let n = 0;
      return fakeResolver({ "rebind.example": () => (n++ === 0 ? [PUBLIC_IP] : ["10.0.0.1"]) });
    };

    it("CONNECT resolves once and dials the address it vetted", async () => {
      const resolve = rebinding();
      proxy = await startEgressProxy({ resolve, privateAllowlist: [], onBlock: (e) => blocks.push(e), dial: dialTo(() => echo.port) });

      const { status, socket } = await connectVia(proxy, "rebind.example:443");
      expect(status).toBe(200);
      expect(await echoRoundTrip(socket, "x")).toBe("x");
      socket.destroy();

      expect(resolve.calls).toEqual(["rebind.example"]);
      expect(dials).toEqual([[PUBLIC_IP, 443]]);
    });

    it("HTTP forward resolves once and dials the address it vetted", async () => {
      const resolve = rebinding();
      proxy = await startEgressProxy({ resolve, privateAllowlist: [], onBlock: (e) => blocks.push(e), dial: dialTo(() => upstream.port) });

      const res = await forward(proxy, "http://rebind.example/");
      expect(res.status).toBe(200);
      expect(resolve.calls).toEqual(["rebind.example"]);
      expect(dials).toEqual([[PUBLIC_IP, 80]]);
      expect(upstream.seen[0]?.headers.host).toBe("rebind.example");
    });

    it("re-vets on every new connection, so a later private answer is blocked", async () => {
      const resolve = rebinding();
      proxy = await startEgressProxy({ resolve, privateAllowlist: [], onBlock: (e) => blocks.push(e), dial: dialTo(() => echo.port) });

      const first = await connectVia(proxy, "rebind.example:443");
      first.socket.destroy();
      const second = await connectVia(proxy, "rebind.example:443");
      second.socket.destroy();

      expect(first.status).toBe(200);
      expect(second.status).toBe(403);
      expect(dials).toEqual([[PUBLIC_IP, 443]]);
      expect(blocks).toEqual([{ host: "rebind.example", port: 443, reason: "NON_PUBLIC_ADDRESS" }]);
    });
  });

  describe("listening for the runner container (KI-029)", () => {
    it("serves only the allowed clients, and never applies that list to its own upstream connections", async () => {
      // An upstream on IPv6 loopback: its address (::1) is not an allowed client, as a real site's never is.
      const v6 = http.createServer((req, res) => res.end(`hello over v6 ${req.url}`));
      await new Promise<void>((r) => v6.listen(0, "::1", r));
      const v6Port = (v6.address() as net.AddressInfo).port;
      try {
        proxy = await startEgressProxy({
          resolve: fakeResolver({}),
          privateAllowlist: [`[::1]:${v6Port}`],
          onBlock: (e) => blocks.push(e),
          listen: { host: "127.0.0.1", allowedClients: ["127.0.0.1"] },
        });
        const ok = await forward(proxy, `http://[::1]:${v6Port}/x`);
        expect(ok.status).toBe(200);
        expect(ok.body).toBe("hello over v6 /x");
        await proxy.close();

        proxy = await startEgressProxy({
          resolve: fakeResolver({}),
          privateAllowlist: [`[::1]:${v6Port}`],
          onBlock: (e) => blocks.push(e),
          listen: { host: "127.0.0.1", allowedClients: ["10.9.9.9"] },
        });
        await expect(forward(proxy, `http://[::1]:${v6Port}/x`)).rejects.toThrow();
      } finally {
        await new Promise((r) => v6.close(r));
      }
    });
  });

  describe("private allowlist", () => {
    it("admits an allowlisted host:port (dialling its resolved address) but not the same host on another port", async () => {
      const resolve = fakeResolver({ "demo-shop": ["172.18.0.5"] });
      proxy = await startEgressProxy({
        resolve,
        privateAllowlist: ["demo-shop:4000"],
        onBlock: (e) => blocks.push(e),
        dial: dialTo(() => upstream.port),
      });

      const ok = await forward(proxy, "http://demo-shop:4000/products");
      expect(ok.status).toBe(200);
      expect(ok.body).toBe("hello from upstream /products");
      expect(dials).toEqual([["172.18.0.5", 4000]]);

      const other = await forward(proxy, "http://demo-shop:4001/products");
      expect(other.status).toBe(403);
      const tunnel = await connectVia(proxy, "demo-shop:4001");
      tunnel.socket.destroy();
      expect(tunnel.status).toBe(403);

      expect(dials).toEqual([["172.18.0.5", 4000]]);
      expect(blocks).toEqual([
        { host: "demo-shop", port: 4001, reason: "NON_PUBLIC_ADDRESS" },
        { host: "demo-shop", port: 4001, reason: "NON_PUBLIC_ADDRESS" },
      ]);
    });

    it("connects to an allowlisted loopback IP:port for real, and blocks a neighbouring loopback port", async () => {
      const resolve = fakeResolver({});
      proxy = await startEgressProxy({
        resolve,
        privateAllowlist: [`127.0.0.1:${upstream.port}`],
        onBlock: (e) => blocks.push(e),
      });

      const ok = await forward(proxy, `http://127.0.0.1:${upstream.port}/cdp`);
      expect(ok.status).toBe(200);
      expect(ok.body).toBe("hello from upstream /cdp");

      const tunnel = await connectVia(proxy, `127.0.0.1:${echo.port}`);
      tunnel.socket.destroy();
      expect(tunnel.status).toBe(403);
      expect(resolve.calls).toEqual([]);
      expect(blocks).toEqual([{ host: "127.0.0.1", port: echo.port, reason: "NON_PUBLIC_ADDRESS" }]);
    });
  });

  describe("browser background services", () => {
    it.each([
      "clients2.google.com",
      "accounts.google.com",
      "content-autofill.googleapis.com",
      "update.googleapis.com",
      "safebrowsing.googleapis.com",
      "stagehand-telemetry.invalid", // Stagehand's in-browser OTel export (Ruling R22)
    ])(
      "denies %s even though it resolves publicly, without resolving it",
      async (host) => {
        const resolve = fakeResolver({ [host]: [PUBLIC_IP] });
        proxy = await startEgressProxy({ resolve, privateAllowlist: [], onBlock: (e) => blocks.push(e), dial: dialTo(() => echo.port) });

        const { status, socket } = await connectVia(proxy, `${host}:443`);
        socket.destroy();
        expect(status).toBe(403);
        expect(resolve.calls).toEqual([]);
        expect(dials).toEqual([]);
        expect(blocks).toEqual([{ host, port: 443, reason: "BACKGROUND_SERVICE_DENIED" }]);
      },
    );

    it("matches background hosts case-insensitively and with a trailing dot", async () => {
      const resolve = fakeResolver({});
      proxy = await startEgressProxy({ resolve, privateAllowlist: [], onBlock: (e) => blocks.push(e), dial: dialTo(() => echo.port) });

      const { status, socket } = await connectVia(proxy, "Clients2.Google.COM.:443");
      socket.destroy();
      expect(status).toBe(403);
      expect(blocks).toEqual([{ host: "clients2.google.com", port: 443, reason: "BACKGROUND_SERVICE_DENIED" }]);
    });
  });

  describe("malformed requests", () => {
    it("rejects origin-form requests (not a proxy request) with 400 and dials nothing", async () => {
      const resolve = fakeResolver({});
      proxy = await startEgressProxy({ resolve, privateAllowlist: [], onBlock: (e) => blocks.push(e), dial: dialTo(() => upstream.port) });
      const { port } = new URL(proxy.url);

      const status = await new Promise<number>((resolveStatus, reject) => {
        const req = http.request({ host: "127.0.0.1", port: Number(port), path: "/not-absolute", agent: false }, (res) => {
          res.resume();
          resolveStatus(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(400);
      expect(dials).toEqual([]);
    });

    it("rejects non-http schemes in forward requests", async () => {
      const resolve = fakeResolver({ "shop.example": [PUBLIC_IP] });
      proxy = await startEgressProxy({ resolve, privateAllowlist: [], onBlock: (e) => blocks.push(e), dial: dialTo(() => upstream.port) });

      const res = await forward(proxy, "ftp://shop.example/file");
      expect(res.status).toBe(400);
      expect(dials).toEqual([]);
    });

    it("rejects a CONNECT without a port", async () => {
      const resolve = fakeResolver({ "shop.example": [PUBLIC_IP] });
      proxy = await startEgressProxy({ resolve, privateAllowlist: [], onBlock: (e) => blocks.push(e), dial: dialTo(() => echo.port) });

      const { status, socket } = await connectVia(proxy, "shop.example");
      socket.destroy();
      expect(status).toBe(400);
      expect(dials).toEqual([]);
    });
  });

  describe("lifecycle", () => {
    it("listens on loopback only and close() tears down open tunnels", async () => {
      const resolve = fakeResolver({ "shop.example": [PUBLIC_IP] });
      proxy = await startEgressProxy({ resolve, privateAllowlist: [], onBlock: (e) => blocks.push(e), dial: dialTo(() => echo.port) });
      expect(new URL(proxy.url).hostname).toBe("127.0.0.1");

      const { status, socket } = await connectVia(proxy, "shop.example:443");
      expect(status).toBe(200);
      const closed = new Promise<void>((r) => socket.once("close", () => r()));
      await proxy.close();
      proxy = undefined;
      await closed;
      expect(socket.destroyed).toBe(true);
    });
  });
});
