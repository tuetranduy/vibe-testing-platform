// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

const SERVICE = "test-token-0123456789abcdef";
const TOKEN = `tap_${"a".repeat(43)}`;
const WEB = "https://tests.example.com";

type Upstream = { url: string; init: RequestInit & { headers: Headers } };

function stubUpstream(respond: (u: Upstream) => Response = () => Response.json({ ok: true })) {
  const calls: Upstream[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = { url: String(input), init: { ...init, headers: new Headers(init?.headers) } };
      calls.push(u);
      return respond(u);
    }),
  );
  return calls;
}

const req = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
  new Request(`${WEB}${path}`, {
    method,
    headers: { host: "tests.example.com", authorization: `Bearer ${TOKEN}`, ...headers },
    body,
  });

beforeEach(() => {
  vi.stubEnv("API_URL", "http://api.internal:3001");
  vi.stubEnv("API_TOKEN", SERVICE);
  vi.stubEnv("WEB_ALLOWED_HOSTS", "tests.example.com");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("/api/ext (V1.2 F4)", () => {
  it.each([
    ["GET", "/api/ext/v1/suites?name=smoke&owner=all", GET, "http://api.internal:3001/v1/suites?name=smoke"],
    ["POST", "/api/ext/v1/suites/ste_1/runs", POST, "http://api.internal:3001/v1/suites/ste_1/runs"],
    ["POST", "/api/ext/v1/suite-runs/srn_1/cancel", POST, "http://api.internal:3001/v1/suite-runs/srn_1/cancel"],
    ["GET", "/api/ext/v1/suite-runs/srn_1", GET, "http://api.internal:3001/v1/suite-runs/srn_1"],
    ["GET", "/api/ext/v1/suite-runs/srn_1/junit.xml", GET, "http://api.internal:3001/v1/suite-runs/srn_1/junit.xml"],
    ["GET", "/api/ext/v1/test-runs/run_1", GET, "http://api.internal:3001/v1/test-runs/run_1"],
    ["GET", "/api/ext/v1/test-runs/run_1/report", GET, "http://api.internal:3001/v1/test-runs/run_1/report"],
    ["GET", "/api/ext/v1/test-runs/run_1/report.md", GET, "http://api.internal:3001/v1/test-runs/run_1/report.md"],
    ["GET", "/api/ext/v1/test-runs/run_1/comparison?baseline=run_0", GET, "http://api.internal:3001/v1/test-runs/run_1/comparison?baseline=run_0"],
  ] as const)("forwards %s %s with the token as X-Api-Token", async (method, path, handler, upstreamUrl) => {
    const calls = stubUpstream();
    const res = await handler(req(method, path, { cookie: "platform_session=sess_0123456789abcdef", "x-session-token": "nope" }, method === "POST" ? "{}" : undefined));
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe(upstreamUrl);
    const h = calls[0]!.init.headers;
    expect(h.get("authorization")).toBe(`Bearer ${SERVICE}`);
    expect(h.get("x-api-token")).toBe(TOKEN);
    expect(h.get("cookie")).toBeNull();
    expect(h.get("x-session-token")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["POST", "/api/ext/v1/test-runs", POST],
    ["GET", "/api/ext/v1/api-tokens", GET],
    ["GET", "/api/ext/v1/settings/llm", GET],
    ["GET", "/api/ext/v1/test-runs/run_1/artifacts/art_1/url", GET],
    ["POST", "/api/ext/v1/suites", POST],
    ["GET", "/api/ext/v1/suites/ste_1/runs%2F..", GET],
  ] as const)("never forwards %s %s", async (method, path, handler) => {
    const calls = stubUpstream();
    expect((await handler(req(method, path, {}, method === "POST" ? "{}" : undefined))).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("needs a token-shaped bearer, an allowed host, and no cross-site browser", async () => {
    const calls = stubUpstream();
    expect((await GET(req("GET", "/api/ext/v1/suites", { authorization: `Bearer ${SERVICE}` }))).status).toBe(401);
    expect((await GET(req("GET", "/api/ext/v1/suites", { authorization: "" }))).status).toBe(401);
    expect((await GET(req("GET", "/api/ext/v1/suites", { host: "evil.example" }))).status).toBe(403);
    expect((await GET(req("GET", "/api/ext/v1/suites", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("passes the API's 429 and Retry-After through (the limit is the API's, KI-040)", async () => {
    stubUpstream(() => Response.json({ code: "TOO_MANY_REQUESTS" }, { status: 429, headers: { "retry-after": "60" } }));
    const over = await GET(req("GET", "/api/ext/v1/suites"));
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
  });

  it("passes the API's answer through: status, JSON, a JUnit file", async () => {
    stubUpstream(() => new Response("<testsuites/>", { status: 200, headers: { "content-type": "application/xml" } }));
    const res = await GET(req("GET", "/api/ext/v1/suite-runs/srn_1/junit.xml"));
    expect(res.headers.get("content-type")).toBe("application/xml");
    expect(await res.text()).toBe("<testsuites/>");
    stubUpstream(() => Response.json({ code: "TOKEN_SCOPE" }, { status: 403 }));
    expect((await POST(req("POST", "/api/ext/v1/suites/ste_1/runs", {}, "{}"))).status).toBe(403);
  });
});
