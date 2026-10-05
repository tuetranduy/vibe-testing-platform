import http from "node:http";
import net from "node:net";
import { normalizeHost, validateTargetUrl, type Resolver } from "@platform/security";
import { STAGEHAND_TELEMETRY_HOST } from "@platform/stagehand-adapter/telemetry";

/**
 * D8 egress guard: an HTTP forward proxy (plain `http:` requests + `CONNECT` tunnels) that every
 * browser connection goes through. It resolves DNS itself, exactly once per connection, rejects
 * any non-public answer (unless the exact `host:port` is allowlisted), and dials the vetted IP —
 * so a DNS answer that changes between check and connect (rebinding) is never followed.
 */

export type EgressBlockReason =
  /** The host is, or resolves to (any address), a non-public address and is not allowlisted. */
  | "NON_PUBLIC_ADDRESS"
  /** The host could not be resolved; nothing to vet, so nothing is dialled. */
  | "DNS_RESOLUTION_FAILED"
  /** A Chromium background service (update, safe browsing, sync, autofill…); denied whatever it resolves to. */
  | "BACKGROUND_SERVICE_DENIED";

export interface EgressBlockEvent {
  /** Normalized host: lowercase, no IPv6 brackets, no trailing dot. */
  host: string;
  port: number;
  reason: EgressBlockReason;
}

/** Opens a TCP connection to an already-vetted IP address. */
export type Dialer = (address: string, port: number) => net.Socket;

export interface EgressProxyOptions {
  resolve: Resolver;
  /** Exact `host:port` entries (IPv6 as `[addr]:port`) admitted without the public-address check. */
  privateAllowlist: string[];
  /** Called once per blocked request or tunnel. Must not throw (errors are swallowed). */
  onBlock: (e: EgressBlockEvent) => void;
  /** Test seam only: how a vetted address is dialled. Defaults to a direct TCP connect to that IP. */
  dial?: Dialer;
  /** Per-address connect timeout. */
  connectTimeoutMs?: number;
  /**
   * Where the proxy listens. Default: loopback, for a browser on this host. A rerun in the runner container
   * (KI-029) reaches it over the runner network: listen on all interfaces and accept only these client
   * addresses (the runner's); every other connection is dropped unread.
   */
  listen?: { host: string; allowedClients: string[] };
}

/** `::ffff:10.0.0.3` → `10.0.0.3`. */
const plainAddress = (a: string | undefined) => (a ?? "").replace(/^::ffff:/, "");

export interface EgressProxy {
  /** `http://127.0.0.1:<port>` — pass to Chromium as `--proxy-server`. */
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Reserved sink for Stagehand's in-browser OTel trace export, which cannot be disabled (Ruling R22).
 * The constant comes from `@platform/stagehand-adapter` (whose default `telemetry.traces.endpoint`
 * points there), so the two can't drift; denying it as a background service keeps it silent (no
 * `egress.blocked` event) and it never resolves (`.invalid`, RFC 6761).
 */
export const STAGEHAND_TELEMETRY_SINK_HOST = STAGEHAND_TELEMETRY_HOST;

/**
 * Chromium background endpoints seen by the Stagehand spike (caveat 4) and their siblings. Denied
 * regardless of what they resolve to: they are never part of the site under test and would leak
 * that a test browser is running.
 */
const BACKGROUND_SERVICE_HOSTS = new Set([
  "accounts.google.com",
  "android.clients.google.com",
  "chromekanonymity-pa.googleapis.com",
  "chromereporting-pa.googleapis.com",
  "chromesyncpasswords-pa.googleapis.com",
  "chromewebstore.googleapis.com",
  "clients2.googleusercontent.com",
  "clientservices.googleapis.com",
  "content-autofill.googleapis.com",
  "dl.google.com",
  "edgedl.me.gvt1.com",
  "optimizationguide-pa.googleapis.com",
  "passwordsleakcheck-pa.googleapis.com",
  "redirector.gvt1.com",
  "safebrowsing.google.com",
  "safebrowsing.googleapis.com",
  "safebrowsingohttpgateway.googleapis.com",
  "sb-ssl.google.com",
  "tools.google.com",
  "update.googleapis.com",
  STAGEHAND_TELEMETRY_SINK_HOST,
]);
const BACKGROUND_SERVICE_PATTERNS = [/^clients\d*\.google\.com$/];

export function isBackgroundServiceHost(host: string): boolean {
  const h = normalizeHost(host);
  return BACKGROUND_SERVICE_HOSTS.has(h) || BACKGROUND_SERVICE_PATTERNS.some((re) => re.test(h));
}

// RFC 7230 hop-by-hop headers plus the proxy-specific ones; never forwarded in either direction.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// Hostnames (LDH + underscore) or IP literals; anything else is not a proxy target.
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

type Verdict =
  | { kind: "allow"; addresses: string[] }
  | { kind: "block"; reason: EgressBlockReason }
  | { kind: "invalid" };

interface Target {
  host: string;
  port: number;
}

function parseAuthority(authority: string): Target | null {
  const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(authority) ?? /^([^:[\]]+):(\d{1,5})$/.exec(authority);
  if (!m) return null;
  return { host: normalizeHost(m[1] ?? ""), port: Number(m[2]) };
}

function stripHopByHop(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const listed = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || listed.has(name)) continue;
    out[name] = value;
  }
  return out;
}

const defaultDial: Dialer = (address, port) => net.connect({ host: address, port });

export async function startEgressProxy(opts: EgressProxyOptions): Promise<EgressProxy> {
  const dial = opts.dial ?? defaultDial;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  const sockets = new Set<net.Socket>();
  const clients = opts.listen ? new Set(opts.listen.allowedClients.map(plainAddress)) : null;
  /** Incoming connections only: a client that is not allowed is dropped unread. */
  const accept = (s: net.Socket) => {
    if (clients && !clients.has(plainAddress(s.remoteAddress))) {
      s.destroy();
      return;
    }
    track(s);
  };
  /** Every socket (clients and upstreams), destroyed on close. */
  const track = (s: net.Socket) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  };

  const block = (target: Target, reason: EgressBlockReason) => {
    try {
      opts.onBlock({ host: target.host, port: target.port, reason });
    } catch {
      // A failing listener must not take the proxy down or change the decision.
    }
  };

  /** Decide whether `host:port` may be reached and, if so, which addresses to dial. Resolves at most once. */
  async function vet(target: Target): Promise<Verdict> {
    const { host, port } = target;
    if (!host || port < 1 || port > 65535) return { kind: "invalid" };
    const ipVersion = net.isIP(host);
    if (ipVersion === 0 && !HOSTNAME_RE.test(host)) return { kind: "invalid" };
    if (isBackgroundServiceHost(host)) return { kind: "block", reason: "BACKGROUND_SERVICE_DENIED" };

    // Reuse the target-URL admission policy (allowlist → IP literal → localhost → resolve + every address public).
    const policy = await validateTargetUrl(`http://${ipVersion === 6 ? `[${host}]` : host}:${port}/`, {
      resolve: opts.resolve,
      privateAllowlist: opts.privateAllowlist,
    });
    if (!policy.allowed) {
      if (policy.reason === "NON_PUBLIC_ADDRESS" || policy.reason === "DNS_RESOLUTION_FAILED") {
        return { kind: "block", reason: policy.reason };
      }
      return { kind: "invalid" };
    }
    if (policy.addresses.length > 0) return { kind: "allow", addresses: policy.addresses };

    // Allowlisted host:port: no address check, but still resolve exactly once and dial what we got.
    if (net.isIP(policy.host) !== 0) return { kind: "allow", addresses: [policy.host] };
    try {
      const addresses = (await opts.resolve(policy.host)).filter((a) => net.isIP(a) !== 0);
      return addresses.length > 0 ? { kind: "allow", addresses } : { kind: "block", reason: "DNS_RESOLUTION_FAILED" };
    } catch {
      return { kind: "block", reason: "DNS_RESOLUTION_FAILED" };
    }
  }

  /** Connect to the first vetted address that accepts; never re-resolves. */
  async function connectVetted(addresses: string[], port: number): Promise<net.Socket> {
    let lastError: unknown = new Error("no addresses");
    for (const address of addresses) {
      try {
        return await new Promise<net.Socket>((resolve, reject) => {
          const socket = dial(address, port);
          const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`connect timeout ${address}:${port}`));
          }, connectTimeoutMs);
          socket.once("connect", () => {
            clearTimeout(timer);
            socket.removeListener("error", reject);
            resolve(socket);
          });
          socket.once("error", (err) => {
            clearTimeout(timer);
            socket.destroy();
            reject(err);
          });
        });
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  const server = http.createServer();
  server.on("connection", accept);

  // Plain-HTTP forward requests (absolute-form request target).
  server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(req.url ?? "");
      } catch {
        return reply(res, 400);
      }
      if (url.protocol !== "http:" || url.username !== "" || url.password !== "") return reply(res, 400);
      const target: Target = { host: normalizeHost(url.hostname), port: url.port === "" ? 80 : Number(url.port) };
      const verdict = await vet(target);
      if (verdict.kind === "invalid") return reply(res, 400);
      if (verdict.kind === "block") {
        block(target, verdict.reason);
        return reply(res, 403);
      }

      let upstreamSocket: net.Socket;
      try {
        upstreamSocket = await connectVetted(verdict.addresses, target.port);
      } catch {
        return reply(res, 502);
      }
      track(upstreamSocket);
      if (req.destroyed) {
        upstreamSocket.destroy();
        return;
      }

      const headers = stripHopByHop(req.headers);
      headers.host = url.host;
      headers.connection = "close";
      const upstream = http.request(
        {
          method: req.method,
          path: `${url.pathname}${url.search}`,
          headers,
          createConnection: () => upstreamSocket,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, stripHopByHop(upRes.headers));
          upRes.pipe(res);
          upRes.on("error", () => res.destroy());
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) reply(res, 502);
        else res.destroy();
      });
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    })().catch(() => {
      if (!res.headersSent) reply(res, 500);
      else res.destroy();
    });
  });

  // TLS (and WebSocket) tunnels.
  server.on("connect", (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    clientSocket.on("error", () => clientSocket.destroy());
    void (async () => {
      const target = parseAuthority(req.url ?? "");
      const verdict = target ? await vet(target) : ({ kind: "invalid" } as const);
      if (!target || verdict.kind === "invalid") return endTunnel(clientSocket, 400, "Bad Request");
      if (verdict.kind === "block") {
        block(target, verdict.reason);
        return endTunnel(clientSocket, 403, "Forbidden");
      }

      let upstream: net.Socket;
      try {
        upstream = await connectVetted(verdict.addresses, target.port);
      } catch {
        return endTunnel(clientSocket, 502, "Bad Gateway");
      }
      track(upstream);
      if (clientSocket.destroyed) {
        upstream.destroy();
        return;
      }
      upstream.on("error", () => clientSocket.destroy());
      upstream.on("close", () => clientSocket.destroy());
      clientSocket.on("close", () => upstream.destroy());
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    })().catch(() => clientSocket.destroy());
  });

  // Browsers send WebSockets through CONNECT; an upgrade on a forward request is not supported.
  server.on("upgrade", (_req: http.IncomingMessage, socket: net.Socket) => endTunnel(socket, 400, "Bad Request"));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, opts.listen?.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as net.AddressInfo;

  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

function reply(res: http.ServerResponse, status: number): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
  res.end(`${status} ${http.STATUS_CODES[status] ?? ""}\n`);
}

function endTunnel(socket: net.Socket, status: number, text: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}
