import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { classifyAddress } from "./ip-policy";

/** Returns every A/AAAA address for a hostname. Throws when resolution fails. */
export type Resolver = (hostname: string) => Promise<string[]>;

export const defaultResolver: Resolver = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

export type UrlPolicyRejectReason =
  | "INVALID_URL"
  | "UNSUPPORTED_PROTOCOL"
  | "CREDENTIALS_IN_URL"
  | "NON_PUBLIC_ADDRESS"
  | "DNS_RESOLUTION_FAILED";

export type UrlPolicyResult =
  | {
      allowed: true;
      url: URL;
      /** Normalized host: lowercase, no IPv6 brackets, no trailing dot. */
      host: string;
      /** Explicit port, or 80/443 inferred from the scheme. */
      port: number;
      /**
       * Vetted addresses the caller should connect to. Empty when the target
       * was admitted through `privateAllowlist` (no resolution is performed).
       */
      addresses: string[];
    }
  | { allowed: false; reason: UrlPolicyRejectReason; detail: string };

export interface UrlPolicyOptions {
  resolve: Resolver;
  /** `host:port` entries (IPv6 as `[addr]:port`) that bypass address checks. Dev/test only. */
  privateAllowlist: string[];
}

const DEFAULT_PORTS: Record<string, number> = { "http:": 80, "https:": 443 };

function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

function isLocalhostName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost");
}

/** True when `host:port` exactly matches an entry of the form `host:port` (IPv6: `[addr]:port`). */
export function isHostPortAllowlisted(host: string, port: number, allowlist: string[]): boolean {
  const wantHost = normalizeHost(host);
  if (!wantHost) return false;
  for (const raw of allowlist) {
    const entry = raw.trim();
    const sep = entry.lastIndexOf(":");
    if (sep <= 0) continue;
    const portText = entry.slice(sep + 1);
    if (!/^\d{1,5}$/.test(portText)) continue;
    const entryHost = normalizeHost(entry.slice(0, sep));
    if (entryHost && entryHost === wantHost && Number(portText) === port) return true;
  }
  return false;
}

const reject = (reason: UrlPolicyRejectReason, detail: string): UrlPolicyResult => ({ allowed: false, reason, detail });

/**
 * Decide whether a user-supplied target URL may be browsed.
 *
 * Order: parse → scheme → credentials → private allowlist (host:port, no DNS)
 * → IP literal / localhost checks (no DNS) → resolve and require that EVERY
 * address is public.
 *
 * Decimal/octal/hex IPv4 hostnames (`http://2130706433`, `http://0177.0.0.1`)
 * are normalized to dotted form by the WHATWG URL parser before we see them.
 *
 * This is an admission check only; the egress proxy must still connect to a
 * vetted address itself to defeat DNS rebinding.
 */
export async function validateTargetUrl(rawUrl: string, opts: UrlPolicyOptions): Promise<UrlPolicyResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return reject("INVALID_URL", "URL could not be parsed");
  }

  const defaultPort = DEFAULT_PORTS[url.protocol];
  if (defaultPort === undefined) {
    return reject("UNSUPPORTED_PROTOCOL", `Protocol ${url.protocol} is not allowed; use http or https`);
  }
  if (url.username !== "" || url.password !== "") {
    return reject("CREDENTIALS_IN_URL", "URLs must not contain a username or password");
  }

  const host = normalizeHost(url.hostname);
  if (!host) return reject("INVALID_URL", "URL has no host");
  const port = url.port === "" ? defaultPort : Number(url.port);

  if (isHostPortAllowlisted(host, port, opts.privateAllowlist)) {
    return { allowed: true, url, host, port, addresses: [] };
  }

  if (isIP(host) !== 0) {
    const cls = classifyAddress(host);
    if (cls !== "public") return reject("NON_PUBLIC_ADDRESS", `${host} is a ${cls} address`);
    return { allowed: true, url, host, port, addresses: [host] };
  }

  if (isLocalhostName(host)) {
    return reject("NON_PUBLIC_ADDRESS", `${host} is a loopback name`);
  }

  let addresses: string[];
  try {
    addresses = await opts.resolve(host);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return reject("DNS_RESOLUTION_FAILED", `Could not resolve ${host}${typeof code === "string" ? ` (${code})` : ""}`);
  }
  if (addresses.length === 0) {
    return reject("DNS_RESOLUTION_FAILED", `${host} resolved to no addresses`);
  }
  for (const address of addresses) {
    const cls = classifyAddress(address);
    if (cls !== "public") {
      return reject("NON_PUBLIC_ADDRESS", `${host} resolves to ${address}, a ${cls} address`);
    }
  }
  return { allowed: true, url, host, port, addresses: [...addresses] };
}
