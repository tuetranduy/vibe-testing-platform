/**
 * Server-only: the external path for API tokens (V1.2 F4), behind app/api/ext/[...path]/route.ts. CI jobs and
 * scripts call `https://<web host>/api/ext/v1/...` with `Authorization: Bearer tap_...`; the API itself stays on
 * the private network.
 *
 * - Forwards only the endpoints a token can reach (the API's TOKEN_ROUTES), each with its own query parameters.
 * - Sends the token to the API as `X-Api-Token`, next to the service `Authorization: Bearer ${API_TOKEN}`. The
 *   API checks the token, its user and its scopes.
 * - No cookies either way; no Origin needed (CI is not a browser). A browser's cross-site request is refused.
 * - The Host must be in WEB_ALLOWED_HOSTS, like the cookie proxy (so the public host CI uses must be listed).
 * - At most EXT_REQUESTS_PER_MINUTE per token and web instance (the API also counts per token and hour).
 */
import "server-only";
import { allowedHosts } from "./proxy";

type Method = "GET" | "POST";

const ID = "[A-Za-z0-9_-]{1,100}";
const ENDPOINTS: { method: Method; pattern: RegExp; query: readonly string[] }[] = [
  { method: "GET", pattern: /^\/v1\/suites$/, query: ["name"] },
  { method: "POST", pattern: new RegExp(`^/v1/suites/${ID}/runs$`), query: [] },
  { method: "POST", pattern: new RegExp(`^/v1/suite-runs/${ID}/cancel$`), query: [] },
  { method: "GET", pattern: new RegExp(`^/v1/suite-runs/${ID}$`), query: [] },
  { method: "GET", pattern: new RegExp(`^/v1/suite-runs/${ID}/junit\\.xml$`), query: [] },
  { method: "GET", pattern: new RegExp(`^/v1/test-runs/${ID}$`), query: [] },
  { method: "GET", pattern: new RegExp(`^/v1/test-runs/${ID}/report$`), query: [] },
  { method: "GET", pattern: new RegExp(`^/v1/test-runs/${ID}/report\\.md$`), query: [] },
  { method: "GET", pattern: new RegExp(`^/v1/test-runs/${ID}/comparison$`), query: ["baseline"] },
];

const PREFIX = "/api/ext";
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "idempotency-key"] as const;
const FORWARDED_RESPONSE_HEADERS = ["content-type", "retry-after", "content-disposition"] as const;
const MAX_BODY_BYTES = 100_000;
export const EXT_REQUESTS_PER_MINUTE = 120;
const TOKEN = /^Bearer (tap_[A-Za-z0-9_-]{20,100})$/;

const error = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  Response.json({ code, message }, { status, headers: { "cache-control": "no-store", ...headers } });

/** Requests per token prefix in the current minute (per web instance). */
const recent = new Map<string, { minute: number; n: number }>();

function overLimit(token: string, now = Date.now()): boolean {
  const key = token.slice(0, 12);
  const minute = Math.floor(now / 60_000);
  const cur = recent.get(key);
  const next = cur && cur.minute === minute ? { minute, n: cur.n + 1 } : { minute, n: 1 };
  recent.set(key, next);
  if (recent.size > 10_000) for (const [k, v] of recent) if (v.minute < minute) recent.delete(k);
  return next.n > EXT_REQUESTS_PER_MINUTE;
}

/** Tests: forget the per-minute counts. */
export function resetExtRateLimit(): void {
  recent.clear();
}

export async function extProxy(req: Request, method: Method): Promise<Response> {
  const host = req.headers.get("host")?.trim().toLowerCase();
  if (!host || !allowedHosts().has(host)) return error(403, "FORBIDDEN_HOST", "This host is not allowed");
  if (req.headers.get("sec-fetch-site") === "cross-site") return error(403, "FORBIDDEN_ORIGIN", "Cross-origin requests are not allowed");

  const url = new URL(req.url);
  const path = url.pathname.startsWith(`${PREFIX}/`) ? url.pathname.slice(PREFIX.length) : "";
  const endpoint = ENDPOINTS.find((e) => e.method === method && e.pattern.test(path));
  if (!endpoint) return error(404, "NOT_FOUND", "Not found");

  const token = TOKEN.exec(req.headers.get("authorization")?.trim() ?? "")?.[1];
  if (!token) return error(401, "TOKEN_REQUIRED", "Send an API token: Authorization: Bearer tap_…", { "www-authenticate": 'Bearer realm="api"' });
  if (overLimit(token)) return error(429, "TOO_MANY_REQUESTS", "Too many requests; slow down", { "retry-after": "60" });

  const apiToken = process.env.API_TOKEN;
  if (!apiToken) return error(500, "PROXY_MISCONFIGURED", "The web server has no API token configured");
  const apiUrl = process.env.API_URL || "http://localhost:3001";
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
  headers.set("authorization", `Bearer ${apiToken}`);
  headers.set("x-api-token", token);

  let body: ArrayBuffer | undefined;
  if (method === "POST") {
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
  const out = new Headers({ "cache-control": "no-store" });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
