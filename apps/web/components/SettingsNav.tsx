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
    <nav aria-label="Settings" className="flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1 [scrollbar-width:none]">
      {links.map((link) => (
        <a
          key={link.href}
          className="inline-flex shrink-0 items-center justify-center rounded-md border border-transparent px-2.5 py-1 text-sm font-medium whitespace-nowrap text-muted-foreground no-underline transition-colors hover:text-foreground aria-[current=page]:border-border aria-[current=page]:bg-background aria-[current=page]:text-foreground dark:aria-[current=page]:bg-input/30"
          href={link.href}
          aria-current={pathname === link.href ? "page" : undefined}
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
}
