"use client";

import { usePathname } from "next/navigation";
import { Icon } from "./Icon";

/** "New test" owns /runs/new; every other /runs page (history, a run) belongs to "Test runs". */
function isCurrent(href: string, pathname: string): boolean {
  if (href === "/runs/new") return pathname === "/runs/new";
  if (href === "/settings") return pathname === "/settings";
  return pathname === "/runs" || (pathname.startsWith("/runs/") && pathname !== "/runs/new");
}

/** The header's navigation: the run history, Settings, and "New test" as the one call to action at its far end. */
export function AppNav() {
  const pathname = usePathname() ?? "";
  const current = (href: string) => (isCurrent(href, pathname) ? "page" : undefined);
  return (
    <nav aria-label="Main" className="app-nav">
      <a className="nav-link" href="/runs" aria-current={current("/runs")}>
        Test runs
      </a>
      <a className="nav-link" href="/settings" aria-current={current("/settings")}>
        Settings
      </a>
      <a className="button button-primary nav-cta" href="/runs/new" aria-current={current("/runs/new")}>
        <Icon name="plus" />New test
      </a>
    </nav>
  );
}
