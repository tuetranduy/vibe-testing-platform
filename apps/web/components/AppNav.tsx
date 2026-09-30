"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import { logout } from "../lib/api";
import { resetMe, useMe } from "../lib/me";
import { Icon } from "./Icon";

/** "New test" owns /runs/new; every other /runs page (history, a run) belongs to "Test runs". */
function isCurrent(href: string, pathname: string): boolean {
  if (href === "/runs/new") return pathname === "/runs/new";
  if (href === "/settings") return pathname === "/settings" || pathname.startsWith("/settings/");
  if (href === "/usage") return pathname === "/usage";
  if (href === "/suites") return pathname === "/suites" || pathname.startsWith("/suites/") || pathname.startsWith("/suite-runs/");
  return pathname === "/runs" || (pathname.startsWith("/runs/") && pathname !== "/runs/new");
}

/**
 * The header's navigation: the run history, suites, usage, Settings, the signed-in user (their account and
 * "Sign out"), and "New test" as the one call to action at its far end. Nothing on the sign-in page.
 */
export function AppNav({ navigate = (url: string) => window.location.assign(url) }: { navigate?: (url: string) => void }) {
  const pathname = usePathname() ?? "";
  const me = useMe(pathname !== "/login");
  const [signingOut, setSigningOut] = useState(false);
  if (pathname === "/login") return null;
  const current = (href: string) => (isCurrent(href, pathname) ? "page" : undefined);

  async function signOut() {
    setSigningOut(true);
    // The cookie is cleared by the proxy whatever the API answers; the sign-in page follows either way.
    await logout().catch(() => {});
    resetMe();
    navigate("/login");
  }

  return (
    <nav aria-label="Main" className="app-nav">
      <a className="nav-link" href="/runs" aria-current={current("/runs")}>
        Test runs
      </a>
      <a className="nav-link" href="/suites" aria-current={current("/suites")}>
        Suites
      </a>
      <a className="nav-link" href="/usage" aria-current={current("/usage")}>
        Usage
      </a>
      <a className="nav-link" href="/settings" aria-current={current("/settings")}>
        Settings
      </a>
      {me && (
        <span className="nav-user">
          <a className="nav-link" href="/account" aria-current={pathname === "/account" ? "page" : undefined} title={me.email}>
            <Icon name="user" />
            <span>{me.name}</span> <span className="visually-hidden">(your account)</span>
          </a>
          <button type="button" className="button button-quiet nav-signout" onClick={() => void signOut()} disabled={signingOut}>
            Sign out
          </button>
        </span>
      )}
      <a className="button button-primary nav-cta" href="/runs/new" aria-current={current("/runs/new")}>
        <Icon name="plus" />
        <span className="nav-cta-label">New test</span>
      </a>
    </nav>
  );
}
