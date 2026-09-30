// @vitest-environment node
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "./proxy";

const request = (path: string, cookie?: string) => new NextRequest(`http://web.test:3000${path}`, { headers: cookie ? { cookie } : {} });

describe("page gate", () => {
  it("redirects to /login with the page to return to when there is no session cookie", () => {
    const res = proxy(request("/runs/run_1?tab=report"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://web.test:3000/login?next=%2Fruns%2Frun_1%3Ftab%3Dreport");
    expect(proxy(request("/")).headers.get("location")).toBe("http://web.test:3000/login");
  });

  it("lets a request with the cookie through", () => {
    const res = proxy(request("/runs", "platform_session=abc"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("does not gate the API proxy, the health check, the login page or assets", () => {
    const pattern = new RegExp(`^${config.matcher[0]!.replace("/(", "/(")}$`);
    for (const path of ["/api/v1/test-runs", "/healthz", "/login", "/_next/static/x.js", "/favicon.ico"])
      expect(pattern.test(path)).toBe(false);
    for (const path of ["/", "/runs", "/runs/new", "/settings", "/usage"]) expect(pattern.test(path)).toBe(true);
  });
});
