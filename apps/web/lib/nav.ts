import type { IconName } from "../components/Icon";

/** The app's destinations: the sidebar, Settings' tabs and the command palette all read these. */
export const MAIN_NAV: readonly { href: string; label: string; icon: IconName }[] = [
  { href: "/runs", label: "Test runs", icon: "activity" },
  { href: "/suites", label: "Suites", icon: "layers" },
  { href: "/usage", label: "Usage", icon: "chart" },
  { href: "/settings", label: "Settings", icon: "gear" },
];

/** Settings' sections. Users and API tokens are shown to administrators only. */
export const SETTINGS_NAV = [
  { href: "/settings", label: "AI models", admin: false },
  { href: "/settings/credentials", label: "Credentials", admin: false },
  { href: "/settings/test-data", label: "Test data", admin: false },
  { href: "/settings/users", label: "Users", admin: true },
  { href: "/settings/tokens", label: "API tokens", admin: true },
] as const;

/** "New test" owns /runs/new; every other /runs page (history, a run) belongs to "Test runs". */
export function isCurrent(href: string, pathname: string): boolean {
  if (href === "/runs/new") return pathname === "/runs/new";
  if (href === "/settings") return pathname === "/settings" || pathname.startsWith("/settings/");
  if (href === "/usage") return pathname === "/usage";
  if (href === "/suites") return pathname === "/suites" || pathname.startsWith("/suites/") || pathname.startsWith("/suite-runs/");
  return pathname === "/runs" || (pathname.startsWith("/runs/") && pathname !== "/runs/new");
}
