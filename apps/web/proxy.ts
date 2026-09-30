import { NextResponse, type NextRequest } from "next/server";

/**
 * Page gate (V1.1 F1): a page request without the session cookie is sent to /login, with the page to
 * return to. Only presence is checked here; the API decides whether the session is still valid (the
 * /api proxy clears the cookie on `401 SESSION_INVALID`, and the pages then land here).
 */
export function proxy(request: NextRequest): NextResponse {
  if (request.cookies.get("platform_session")?.value) return NextResponse.next();
  const login = new URL("/login", request.url);
  const next = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  if (next !== "/") login.searchParams.set("next", next);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything but the API proxy, the health check, the login page and Next's own assets.
  matcher: ["/((?!api/|healthz|login|_next/|favicon\\.ico).*)"],
};
