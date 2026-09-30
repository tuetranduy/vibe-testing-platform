"use client";

import { usePathname } from "next/navigation";
import { isAdminUser, useMe } from "../lib/me";

const ALL = [
  { href: "/settings", label: "AI models", admin: false },
  { href: "/settings/credentials", label: "Credentials", admin: false },
  { href: "/settings/test-data", label: "Test data", admin: false },
  { href: "/settings/users", label: "Users", admin: true },
  { href: "/settings/tokens", label: "API tokens", admin: true },
] as const;

/** Settings' sections. Users and API tokens are shown to administrators only. */
export function SettingsNav() {
  const pathname = usePathname() ?? "";
  const me = useMe();
  const links = ALL.filter((l) => !l.admin || isAdminUser(me));
  return (
    <nav aria-label="Settings" className="subnav">
      {links.map((l) => (
        <a key={l.href} className="subnav-link" href={l.href} aria-current={pathname === l.href ? "page" : undefined}>
          {l.label}
        </a>
      ))}
    </nav>
  );
}
