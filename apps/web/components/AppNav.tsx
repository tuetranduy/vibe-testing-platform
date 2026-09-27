"use client";

import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/runs", label: "Test runs" },
  { href: "/runs/new", label: "New test" },
] as const;

/** "New test" owns /runs/new; every other /runs page (history, a run) belongs to "Test runs". */
function isCurrent(href: string, pathname: string): boolean {
  if (href === "/runs/new") return pathname === "/runs/new";
  return pathname === "/runs" || (pathname.startsWith("/runs/") && pathname !== "/runs/new");
}

export function AppNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="Main" className="app-nav">
      {LINKS.map(({ href, label }) => (
        <a key={href} href={href} aria-current={isCurrent(href, pathname) ? "page" : undefined}>
          {label}
        </a>
      ))}
    </nav>
  );
}
