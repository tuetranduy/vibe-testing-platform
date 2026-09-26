/**
 * Server-only: the browser → API proxy behind app/api/[...path]/route.ts (Ruling R49).
 *
 * - Forwards only the V1 endpoints below (method + path pattern); everything else is 404 and never
 *   reaches the API. Only each endpoint's own query parameters are forwarded.
 * - Adds `Authorization: Bearer ${API_TOKEN}` here, on the server. The browser's Authorization and
 *   Cookie headers (and every other header not listed) are dropped.
 * - Rejects every request whose Host header isn't in WEB_ALLOWED_HOSTS (Ruling R56): under DNS
 *   rebinding an attacker's name resolves to this app, and Origin and Host then agree with each
 *   other — only the allow-list tells them apart. Browsers can't forge Host (X-Forwarded-Host they
 *   can, so it is ignored).
 * - Rejects `Sec-Fetch-Site: cross-site` on every method, and POST/PUT whose Origin isn't on an
 *   allowed host (CSRF).
 * - Streams responses (SSE included) straight through, uncached.
 *
 * API_TOKEN is read from the server's environment at request time; it is never NEXT_PUBLIC_ and is
 * never put into a response. This module must only be imported by route handlers.
 */

type Method = "GET" | "POST" | "PUT";

const ID = "[A-Za-z0-9_-]{1,100}";
const ENDPOINTS: { method: Method; pattern: RegExp; query: readonly string[] }[] = [
  { method: "POST", pattern: /^\/v1\/test-runs$/, query: [] },
  { method: "GET", pattern: /^\/v1\/test-runs$/, query: ["limit", "cursor"] },
  { method: "GET", pattern: new RegExp(`^/v1/test-runs/${ID}$`), query: [] },
  { method: "GET", pattern: new RegExp(`^/v1/test-runs/${ID}/events$`), query: ["afterSequence"] },
  { method: "GET", pattern: new RegExp(`^/v1/test-runs/${ID}/criteria$`), query: [] },
  { method: "PUT", pattern: new RegExp(`^/v1/test-runs/${ID}/criteria$`), query: [] },
  { method: "POST", pattern: new RegExp(`^/v1/test-runs/${ID}/criteria/confirm$`), query: [] },
  { method: "POST", pattern: new RegExp(`^/v1/test-runs/${ID}/cancel$`), query: [] },
  { method: "GET", pattern: new RegExp(`^/v1/test-runs/${ID}/report$`), query: [] },
  { method: "GET", pattern: new RegExp(`^/v1/test-runs/${ID}/artifacts/${ID}/url$`), query: ["reveal"] },
];

const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "idempotency-key", "last-event-id"] as const;
const FORWARDED_RESPONSE_HEADERS = ["content-type", "retry-after"] as const;
const MAX_BODY_BYTES = 1_000_000;
const PREFIX = "/api";

const error = (status: number, code: string, message: string) =>
  Response.json({ code, message }, { status, headers: { "cache-control": "no-store" } });

const DEFAULT_ALLOWED_HOSTS = "localhost:3000,127.0.0.1:3000";

/** WEB_ALLOWED_HOSTS: comma-separated host[:port] the UI is served on (server env, read per request). */
function allowedHosts(): Set<string> {
  const raw = process.env.WEB_ALLOWED_HOSTS || DEFAULT_ALLOWED_HOSTS;
  return new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Mutating requests must come from a page on an allowed host. */
function allowedOrigin(req: Request, hosts: Set<string>): boolean {
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && hosts.has(url.host);
  } catch {
    return false;
  }
}

export async function proxy(req: Request, method: Method): Promise<Response> {
  const hosts = allowedHosts();
  // Only the Host header: req.url may be derived from X-Forwarded-Host, which a page can set.
  const host = req.headers.get("host")?.trim().toLowerCase();
  if (!host || !hosts.has(host)) return error(403, "FORBIDDEN_HOST", "This host is not allowed");
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return error(403, "FORBIDDEN_ORIGIN", "Cross-origin requests are not allowed");
  }

  const url = new URL(req.url);
  // The raw (still percent-encoded) path: an encoded "/" or "." can't match an ID segment.
  const path = url.pathname.startsWith(`${PREFIX}/`) ? url.pathname.slice(PREFIX.length) : "";
  const endpoint = ENDPOINTS.find((e) => e.method === method && e.pattern.test(path));
  if (!endpoint) return error(404, "NOT_FOUND", "Not found");

  if (method !== "GET" && !allowedOrigin(req, hosts)) {
    return error(403, "FORBIDDEN_ORIGIN", "Cross-origin requests are not allowed");
  }

  const apiUrl = process.env.API_URL || "http://localhost:3001";
  const token = process.env.API_TOKEN;
  if (!token) return error(500, "PROXY_MISCONFIGURED", "The web server has no API token configured");

  const target = new URL(path, apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);
  for (const name of endpoint.query) {
    const value = url.searchParams.get(name);
    if (value !== null) target.searchParams.set(name, value);
  }

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${token}`);

  let body: ArrayBuffer | undefined;
  if (method !== "GET") {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) return error(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    if (buf.byteLength > 0) body = buf;
    else headers.delete("content-type");
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, { method, headers, body, cache: "no-store", redirect: "manual", signal: req.signal });
  } catch {
    return error(502, "UPSTREAM_UNAVAILABLE", "The testing API is unreachable");
  }

  const out = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  if (out.get("content-type")?.startsWith("text/event-stream")) {
    // no-transform also stops Next's gzip from buffering the stream.
    out.set("cache-control", "no-cache, no-transform");
    out.set("x-accel-buffering", "no");
  } else {
    out.set("cache-control", "no-store");
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
