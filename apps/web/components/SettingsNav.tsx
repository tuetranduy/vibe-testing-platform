"use client";

import { usePathname } from "next/navigation";
import { isAdminUser, useMe } from "../lib/me";
import { SETTINGS_NAV } from "../lib/nav";

/** Settings' sections. Users and API tokens are shown to administrators only. */
export function SettingsNav() {
  const pathname = usePathname() ?? "";
  const me = useMe();
  const links = SETTINGS_NAV.filter((l) => !l.admin || isAdminUser(me));
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
