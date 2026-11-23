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
    <nav aria-label="Settings" className="flex w-full gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]">
      {links.map((l) => (
        <a key={l.href} className="relative px-3 pt-2 pb-3 text-sm font-medium whitespace-nowrap text-(--text-subtle) no-underline transition-colors hover:text-foreground aria-[current=page]:font-semibold aria-[current=page]:text-foreground aria-[current=page]:after:absolute aria-[current=page]:after:inset-x-2 aria-[current=page]:after:-bottom-px aria-[current=page]:after:h-0.5 aria-[current=page]:after:rounded-full aria-[current=page]:after:bg-[image:var(--accent-gradient)]" href={l.href} aria-current={pathname === l.href ? "page" : undefined}>
          {l.label}
        </a>
      ))}
    </nav>
  );
}
