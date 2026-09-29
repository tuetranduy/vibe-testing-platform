// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST, PUT } from "./route";

const TOKEN = "test-token-0123456789abcdef";
const WEB = "http://web.test:3000";

type Upstream = { url: string; init: RequestInit & { headers: Headers } };

function stubUpstream(respond: (u: Upstream) => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const calls: Upstream[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = { url: String(input), init: { ...init, headers: new Headers(init?.headers) } };
    calls.push(u);
    return respond(u);
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}

const req = (method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}) =>
  new Request(`${WEB}${path}`, { method, headers: { host: "web.test:3000", ...init.headers }, body: init.body });

const sameOrigin = { origin: WEB, "content-type": "application/json" };

beforeEach(() => {
  vi.stubEnv("API_URL", "http://api.internal:3001");
  vi.stubEnv("API_TOKEN", TOKEN);
  vi.stubEnv("WEB_ALLOWED_HOSTS", "web.test:3000");
});
afterEach(() => vi.unstubAllEnvs());

describe("API proxy allow-list", () => {
  it.each([
    ["POST", "/api/v1/test-runs", POST],
    ["GET", "/api/v1/test-runs?limit=20&cursor=abc", GET],
    ["GET", "/api/v1/test-runs/run_1", GET],
    ["GET", "/api/v1/test-runs/run_1/events?afterSequence=3", GET],
    ["GET", "/api/v1/test-runs/run_1/criteria", GET],
    ["PUT", "/api/v1/test-runs/run_1/criteria", PUT],
    ["POST", "/api/v1/test-runs/run_1/criteria/confirm", POST],
    ["POST", "/api/v1/test-runs/run_1/cancel", POST],
    ["GET", "/api/v1/test-runs/run_1/report", GET],
    ["GET", "/api/v1/test-runs/run_1/artifacts/art_1/url?reveal=true", GET],
    ["GET", "/api/v1/settings/llm", GET],
    ["PUT", "/api/v1/settings/llm", PUT],
    ["PUT", "/api/v1/settings/llm/keys/anthropic", PUT],
    ["PUT", "/api/v1/settings/llm/keys/gemini", PUT],
  ] as const)("forwards %s %s", async (method, path, handler) => {
    const calls = stubUpstream();
    const res = await handler(req(method, path, method === "GET" ? {} : { headers: sameOrigin, body: "{}" }));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`http://api.internal:3001${path.replace(/^\/api/, "")}`);
    expect(calls[0]!.init.method).toBe(method);
  });

  it.each([
    ["GET", "/api/healthz", GET],
    ["GET", "/api/v1/admin", GET],
    ["GET", "/api/v1/test-runs/run_1/secrets", GET],
    ["POST", "/api/v1/test-runs/run_1", POST], // right path, wrong method
    ["PUT", "/api/v1/test-runs", PUT],
    ["GET", "/api/v1/test-runs/run_1/criteria/confirm", GET],
    ["GET", "/api/v1/test-runs/..%2F..%2Fadmin", GET],
    ["GET", "/api/v1/test-runs/run%2F1/report", GET],
    ["GET", "/api/v1/test-runs/run_1/artifacts/a/b/url", GET],
    ["POST", "/api/v1/settings/llm", POST],
    ["GET", "/api/v1/settings/llm/keys/anthropic", GET], // keys are write-only
    ["PUT", "/api/v1/settings/llm/keys/openai", PUT],
    ["PUT", "/api/v1/settings/llm/keys/anthropic/extra", PUT],
    ["GET", "/api/v1/settings", GET],
  ] as const)("rejects %s %s with 404 and never forwards it", async (method, path, handler) => {
    const calls = stubUpstream();
    const res = await handler(req(method, path, method === "GET" ? {} : { headers: sameOrigin, body: "{}" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(calls).toHaveLength(0);
  });

  it("forwards only the query parameters the endpoint accepts", async () => {
    const calls = stubUpstream();
    await GET(req("GET", "/api/v1/test-runs/run_1/artifacts/art_1/url?reveal=true&token=x&redirect=http://evil"));
    expect(calls[0]!.url).toBe("http://api.internal:3001/v1/test-runs/run_1/artifacts/art_1/url?reveal=true");
    await GET(req("GET", "/api/v1/test-runs/run_1?anything=1"));
    expect(calls[1]!.url).toBe("http://api.internal:3001/v1/test-runs/run_1");
  });
});

describe("API proxy headers", () => {
  it("adds the server-side bearer token and strips the browser's credentials", async () => {
    const calls = stubUpstream();
    await POST(
      req("POST", "/api/v1/test-runs", {
        headers: {
          ...sameOrigin,
          authorization: "Bearer browser-supplied",
          cookie: "session=abc",
          "idempotency-key": "k-1",
          "x-forwarded-for": "1.2.3.4",
          "x-custom": "nope",
        },
        body: JSON.stringify({ a: 1 }),
      }),
    );
    const h = calls[0]!.init.headers;
    expect(h.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(h.get("cookie")).toBeNull();
    expect(h.get("idempotency-key")).toBe("k-1");
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("x-forwarded-for")).toBeNull();
    expect(h.get("x-custom")).toBeNull();
    expect(h.get("origin")).toBeNull();
    expect(new TextDecoder().decode(calls[0]!.init.body as ArrayBuffer)).toBe('{"a":1}');
  });

  it("forwards accept and last-event-id for the event stream", async () => {
    const calls = stubUpstream();
    await GET(
      req("GET", "/api/v1/test-runs/run_1/events", { headers: { accept: "text/event-stream", "last-event-id": "17", cookie: "c=1" } }),
    );
    const h = calls[0]!.init.headers;
    expect(h.get("accept")).toBe("text/event-stream");
    expect(h.get("last-event-id")).toBe("17");
    expect(h.get("cookie")).toBeNull();
    expect(h.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("does not pass upstream cookies or auth challenges back to the browser, and disables caching", async () => {
    stubUpstream(
      () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json", "set-cookie": "x=1", "www-authenticate": "Bearer", "x-internal": "1" },
        }),
    );
    const res = await GET(req("GET", "/api/v1/test-runs/run_1"));
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(res.headers.get("x-internal")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("fails closed when API_TOKEN is not configured", async () => {
    vi.stubEnv("API_TOKEN", "");
    const calls = stubUpstream();
    const res = await GET(req("GET", "/api/v1/test-runs/run_1"));
    expect(res.status).toBe(500);
    expect(calls).toHaveLength(0);
  });

  it("answers 502 when the API is unreachable, without leaking the token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError(`connect ECONNREFUSED ${TOKEN}`))));
    const res = await GET(req("GET", "/api/v1/test-runs/run_1"));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("UPSTREAM_UNAVAILABLE");
    expect(text).not.toContain(TOKEN);
  });
});

describe("API proxy CSRF (Origin check)", () => {
  it.each([
    ["a foreign origin", { origin: "http://evil.test", "content-type": "application/json" }],
    ["a same-host origin on another port", { origin: "http://web.test:4000", "content-type": "application/json" }],
    ["no origin", { "content-type": "application/json" }],
    ["an opaque origin", { origin: "null", "content-type": "application/json" }],
  ])("rejects a mutating request with %s", async (_label, headers) => {
    const calls = stubUpstream();
    const post = await POST(req("POST", "/api/v1/test-runs/run_1/cancel", { headers, body: "{}" }));
    const put = await PUT(req("PUT", "/api/v1/test-runs/run_1/criteria", { headers, body: "{}" }));
    expect(post.status).toBe(403);
    expect(put.status).toBe(403);
    expect(await post.json()).toMatchObject({ code: "FORBIDDEN_ORIGIN" });
    expect(calls).toHaveLength(0);
  });

  it("accepts an Origin on any allowed host", async () => {
    vi.stubEnv("WEB_ALLOWED_HOSTS", "web.test:3000,localhost:3000");
    const calls = stubUpstream();
    const res = await POST(
      req("POST", "/api/v1/test-runs/run_1/cancel", { headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: "{}" }),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("rejects a non-http(s) Origin even when its host is allowed", async () => {
    const calls = stubUpstream();
    const res = await POST(
      req("POST", "/api/v1/test-runs/run_1/cancel", { headers: { origin: "chrome-extension://web.test:3000", "content-type": "application/json" }, body: "{}" }),
    );
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("allows a GET without an Origin header", async () => {
    const calls = stubUpstream();
    const res = await GET(req("GET", "/api/v1/test-runs/run_1"));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

describe("API proxy host allow-list (DNS rebinding)", () => {
  const FORBIDDEN_HOST = { code: "FORBIDDEN_HOST", message: "This host is not allowed" };
  const reqOn = (host: string | null, method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
    new Request(`http://${host ?? "web.test:3000"}${path}`, {
      method,
      headers: host === null ? headers : { host, ...headers },
      body,
    });

  it.each([
    ["GET", "/api/v1/test-runs", GET],
    ["GET", "/api/v1/test-runs/run_1/report", GET],
    ["GET", "/api/v1/test-runs/run_1/artifacts/art_1/url?reveal=true", GET],
    ["GET", "/api/v1/admin", GET], // not even a 404 is given away
  ] as const)("rejects %s %s on a host that isn't listed", async (method, path, handler) => {
    const calls = stubUpstream();
    const res = await handler(reqOn("other.test:3000", method, path));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(FORBIDDEN_HOST);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(calls).toHaveLength(0);
  });

  it("rejects a rebound name even when Origin and Host agree (evil.example:3000 → this app's IP)", async () => {
    const calls = stubUpstream();
    const rebound = { origin: "http://evil.example:3000", "content-type": "application/json" };
    const read = await GET(reqOn("evil.example:3000", "GET", "/api/v1/test-runs/run_1/artifacts/art_1/url?reveal=true", rebound));
    const create = await POST(reqOn("evil.example:3000", "POST", "/api/v1/test-runs", rebound, "{}"));
    const confirm = await POST(reqOn("evil.example:3000", "POST", "/api/v1/test-runs/run_1/criteria/confirm", rebound, "{}"));
    const edit = await PUT(reqOn("evil.example:3000", "PUT", "/api/v1/test-runs/run_1/criteria", rebound, "{}"));
    for (const res of [read, create, confirm, edit]) {
      expect(res.status).toBe(403);
      // Static body: the attacker's host name is never echoed back.
      expect(await res.text()).not.toContain("evil");
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects a request without a Host header", async () => {
    const calls = stubUpstream();
    const res = await GET(reqOn(null, "GET", "/api/v1/test-runs/run_1"));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("ignores X-Forwarded-Host (a same-origin page can set it; it can't set Host)", async () => {
    const calls = stubUpstream();
    const res = await GET(reqOn("evil.example:3000", "GET", "/api/v1/test-runs/run_1", { "x-forwarded-host": "web.test:3000" }));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("defaults to localhost:3000 and 127.0.0.1:3000 when WEB_ALLOWED_HOSTS is unset", async () => {
    vi.stubEnv("WEB_ALLOWED_HOSTS", undefined);
    const calls = stubUpstream();
    expect((await GET(reqOn("localhost:3000", "GET", "/api/v1/test-runs/run_1"))).status).toBe(200);
    expect((await GET(reqOn("127.0.0.1:3000", "GET", "/api/v1/test-runs/run_1"))).status).toBe(200);
    expect((await GET(reqOn("web.test:3000", "GET", "/api/v1/test-runs/run_1"))).status).toBe(403);
    expect((await GET(reqOn("localhost:4000", "GET", "/api/v1/test-runs/run_1"))).status).toBe(403);
    expect(calls).toHaveLength(2);
  });

  it("reads a comma-separated list, ignoring spaces, case and empty entries", async () => {
    vi.stubEnv("WEB_ALLOWED_HOSTS", " Testing.Example.com , ,10.0.0.5:3000,");
    const calls = stubUpstream();
    expect((await GET(reqOn("testing.example.com", "GET", "/api/v1/test-runs/run_1"))).status).toBe(200);
    expect((await GET(reqOn("TESTING.EXAMPLE.COM", "GET", "/api/v1/test-runs/run_1"))).status).toBe(200);
    expect((await GET(reqOn("10.0.0.5:3000", "GET", "/api/v1/test-runs/run_1"))).status).toBe(200);
    // A listed name without a port matches only that exact Host (the default port).
    expect((await GET(reqOn("testing.example.com:8080", "GET", "/api/v1/test-runs/run_1"))).status).toBe(403);
    expect(calls).toHaveLength(3);
  });

  it.each([
    ["GET", "/api/v1/test-runs/run_1/artifacts/art_1/url?reveal=true", GET],
    ["POST", "/api/v1/test-runs/run_1/cancel", POST],
    ["PUT", "/api/v1/test-runs/run_1/criteria", PUT],
  ] as const)("rejects %s %s marked Sec-Fetch-Site: cross-site", async (method, path, handler) => {
    const calls = stubUpstream();
    const headers = { ...sameOrigin, "sec-fetch-site": "cross-site" };
    const res = await handler(req(method, path, method === "GET" ? { headers } : { headers, body: "{}" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "FORBIDDEN_ORIGIN" });
    expect(calls).toHaveLength(0);
  });

  it.each(["same-origin", "none"])("allows Sec-Fetch-Site: %s", async (site) => {
    const calls = stubUpstream();
    const get = await GET(req("GET", "/api/v1/test-runs/run_1", { headers: { "sec-fetch-site": site } }));
    const post = await POST(req("POST", "/api/v1/test-runs/run_1/cancel", { headers: { ...sameOrigin, "sec-fetch-site": site }, body: "{}" }));
    expect(get.status).toBe(200);
    expect(post.status).toBe(200);
    expect(calls).toHaveLength(2);
  });
});

describe("API proxy responses", () => {
  it("passes API error bodies and statuses through unchanged", async () => {
    const body = {
      code: "TARGET_NOT_ALLOWED",
      message: "Target URL is not allowed: resolves to a private address",
      issues: [{ path: ["targetUrl"], message: "resolves to a private address" }],
    };
    stubUpstream(() => Response.json(body, { status: 422 }));
    const res = await POST(req("POST", "/api/v1/test-runs", { headers: sameOrigin, body: "{}" }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(body);

    stubUpstream(() => Response.json({ code: "TOO_MANY_ACTIVE_RUNS", message: "Too many active runs" }, { status: 429 }));
    const res429 = await POST(req("POST", "/api/v1/test-runs", { headers: sameOrigin, body: "{}" }));
    expect(res429.status).toBe(429);
    expect(await res429.json()).toEqual({ code: "TOO_MANY_ACTIVE_RUNS", message: "Too many active runs" });
  });

  it("streams SSE through without buffering", async () => {
    const enc = new TextEncoder();
    let push!: (s: string) => void;
    let end!: () => void;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(c) {
        push = (s) => c.enqueue(enc.encode(s));
        end = () => c.close();
      },
    });
    const calls = stubUpstream(
      () => new Response(upstreamBody, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } }),
    );
    const res = await GET(req("GET", "/api/v1/test-runs/run_1/events", { headers: { accept: "text/event-stream" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(calls[0]!.init.cache).toBe("no-store");

    // The first frame is readable before the upstream stream has finished.
    const reader = res.body!.getReader();
    push("id: 1\nevent: stage.started\ndata: {}\n\n");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("id: 1\nevent: stage.started\ndata: {}\n\n");
    push(": ping\n\n");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": ping\n\n");
    end();
    expect((await reader.read()).done).toBe(true);
  });

  it("aborts the upstream request when the browser disconnects", async () => {
    const calls = stubUpstream(() => new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } }));
    const controller = new AbortController();
    const r = new Request(`${WEB}/api/v1/test-runs/run_1/events`, { headers: { host: "web.test:3000" }, signal: controller.signal });
    await GET(r);
    controller.abort();
    expect(calls[0]!.init.signal?.aborted).toBe(true);
  });
});
