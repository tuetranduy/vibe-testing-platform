"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { logout } from "../lib/api";
import { isAdminUser, resetMe, useMe } from "../lib/me";
import { isCurrent, MAIN_NAV, SETTINGS_NAV } from "../lib/nav";
import { isSidebarCollapsed, setSidebarCollapsed } from "../lib/theme";
import { Brand } from "./Brand";
import { CommandPalette } from "./CommandPalette";
import { Icon } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0]![0]! + parts.at(-1)![0]! : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/**
 * The app's sidebar: the brand, "New test" (the one call to action), the run history, suites, usage and
 * Settings (with its sections while you are in them), the theme, and the signed-in user with "Sign out".
 * Collapses to an icon rail on desktop; below 900px it is a drawer opened from a top bar. ⌘K opens the
 * command palette from anywhere. Nothing on the sign-in page.
 */
export function AppNav({ navigate = (url: string) => window.location.assign(url) }: { navigate?: (url: string) => void }) {
  const pathname = usePathname() ?? "";
  const me = useMe(pathname !== "/login");
  const [signingOut, setSigningOut] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);

  useEffect(() => setCollapsed(isSidebarCollapsed()), []);

  useEffect(() => {
    if (pathname === "/login") return;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pathname]);

  const closeDrawer = useCallback((restoreFocus: boolean) => {
    setDrawerOpen(false);
    if (restoreFocus) menuButton.current?.focus();
  }, []);

  useEffect(() => {
    if (!drawerOpen) return;
    sidebar.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeDrawer(true);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen, closeDrawer]);

  if (pathname === "/login") return null;
  const current = (href: string) => (isCurrent(href, pathname) ? "page" : undefined);
  const inSettings = isCurrent("/settings", pathname);
  const settingsLinks = SETTINGS_NAV.filter((l) => !l.admin || isAdminUser(me));

  async function signOut() {
    setSigningOut(true);
    // The cookie is cleared by the proxy whatever the API answers; the sign-in page follows either way.
    await logout().catch(() => {});
    resetMe();
    navigate("/login");
  }

  function toggleCollapsed() {
    setSidebarCollapsed(!collapsed);
    setCollapsed(!collapsed);
  }

  return (
    <>
      <div className="topbar">
        <button
          ref={menuButton}
          type="button"
          className="icon-button"
          aria-label="Open menu"
          aria-controls="sidebar"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <Icon name="menu" />
        </button>
        <Brand />
        <a className="button button-primary topbar-cta" href="/runs/new" aria-label="New test">
          <Icon name="plus" />
        </a>
      </div>

      <aside id="sidebar" ref={sidebar} className="sidebar" data-open={drawerOpen} tabIndex={-1} aria-label="Sidebar">
        <div className="sidebar-head">
          <Brand />
          <button
            type="button"
            className="icon-button sidebar-collapse"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={toggleCollapsed}
          >
            <Icon name="sidebar" />
          </button>
        </div>

        <a className="button button-primary nav-cta" href="/runs/new" aria-current={current("/runs/new")} title="New test">
          <Icon name="plus" />
          <span className="nav-cta-label">New test</span>
        </a>

        <button type="button" className="jump-trigger" onClick={() => setPaletteOpen(true)} title="Search or jump to (⌘K)">
          <Icon name="search" />
          <span className="jump-label">Search or jump to…</span>
          <kbd aria-hidden="true">⌘K</kbd>
        </button>

        <nav aria-label="Main" className="app-nav">
          <div className="nav-section-label" aria-hidden="true">
            Workspace
          </div>
          {MAIN_NAV.map((n) => (
            <div key={n.href}>
              <a className="nav-link" href={n.href} aria-current={current(n.href)} title={n.label}>
                <Icon name={n.icon} />
                <span className="nav-label">{n.label}</span>
              </a>
              {n.href === "/settings" && inSettings && (
                <div className="nav-sub">
                  {settingsLinks.map((l) => (
                    <a key={l.href} className="nav-sub-link" href={l.href} aria-current={pathname === l.href ? "page" : undefined}>
                      {l.label}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <ThemeToggle />
          {me && (
            <div className="nav-user">
              <a className="user-link" href="/account" aria-current={pathname === "/account" ? "page" : undefined} title={me.email}>
                <span className="avatar" aria-hidden="true">
                  {initials(me.name)}
                </span>
                <span className="user-text">
                  <span className="user-name">{me.name}</span>
                  <span className="user-email" aria-hidden="true">
                    {me.email}
                  </span>
                </span>{" "}
                <span className="visually-hidden">(your account)</span>
              </a>
              <button
                type="button"
                className="icon-button nav-signout"
                aria-label="Sign out"
                title="Sign out"
                onClick={() => void signOut()}
                disabled={signingOut}
              >
                <Icon name="logout" />
              </button>
            </div>
          )}
        </div>
      </aside>

      <div className="sidebar-scrim" hidden={!drawerOpen} onClick={() => closeDrawer(false)} />

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} admin={isAdminUser(me)} navigate={navigate} />
    </>
  );
}
