"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MAIN_NAV, SETTINGS_NAV } from "../lib/nav";
import { applyTheme } from "../lib/theme";
import { Icon, type IconName } from "./Icon";

type Command = { id: string; group: string; label: string; icon: IconName; hint?: string; run: () => void };

/**
 * ⌘K / Ctrl-K: jump to any page or switch the theme by typing. A combobox over a listbox, so arrow keys,
 * Enter and Escape work and screen readers hear the active option.
 */
export function CommandPalette({
  open,
  onClose,
  admin,
  navigate,
}: {
  open: boolean;
  onClose: () => void;
  admin: boolean;
  navigate: (url: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const listId = useId();

  const commands = useMemo<Command[]>(() => {
    const go = (href: string) => () => navigate(href);
    return [
      { id: "new", group: "Go to", label: "New test", icon: "plus", hint: "/runs/new", run: go("/runs/new") },
      ...MAIN_NAV.map((n) => ({ id: n.href, group: "Go to", label: n.label, icon: n.icon, hint: n.href, run: go(n.href) })),
      ...SETTINGS_NAV.filter((s) => !s.admin || admin)
        .filter((s) => s.href !== "/settings")
        .map((s) => ({ id: s.href, group: "Go to", label: `Settings: ${s.label}`, icon: "gear" as const, hint: s.href, run: go(s.href) })),
      { id: "/account", group: "Go to", label: "Your account", icon: "user", hint: "/account", run: go("/account") },
      { id: "/account/tokens", group: "Go to", label: "Your API tokens", icon: "key", hint: "/account/tokens", run: go("/account/tokens") },
      { id: "theme-light", group: "Theme", label: "Light theme", icon: "sun", run: () => applyTheme("light") },
      { id: "theme-dark", group: "Theme", label: "Dark theme", icon: "moon", run: () => applyTheme("dark") },
      { id: "theme-system", group: "Theme", label: "System theme", icon: "monitor", run: () => applyTheme("system") },
    ];
  }, [admin, navigate]);

  const q = query.trim().toLowerCase();
  const shown = q ? commands.filter((c) => `${c.label} ${c.hint ?? ""} ${c.group}`.toLowerCase().includes(q)) : commands;

  useEffect(() => {
    if (open) {
      returnFocus.current = document.activeElement as HTMLElement | null;
      setQuery("");
      setActive(0);
    } else {
      returnFocus.current?.focus?.();
    }
  }, [open]);

  if (!open) return null;

  function runAt(i: number) {
    const c = shown[i];
    if (!c) return;
    onClose();
    c.run();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (shown.length ? (i + 1) % shown.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (shown.length ? (i - 1 + shown.length) % shown.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  const optionId = (i: number) => `${listId}-${i}`;
  let lastGroup = "";

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Search or jump to" className="palette">
        <div className="palette-search">
          <Icon name="search" />
          <input
            autoFocus
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={shown.length ? optionId(active) : undefined}
            aria-label="Search pages and actions"
            placeholder="Search pages and actions…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {shown.length === 0 ? (
          <p className="palette-empty">Nothing matches “{query}”.</p>
        ) : (
          <ul id={listId} role="listbox" aria-label="Pages and actions" className="palette-list">
            {shown.map((c, i) => {
              const head = c.group !== lastGroup;
              lastGroup = c.group;
              return (
                <li key={c.id} role="presentation">
                  {head && (
                    <div className="palette-group" aria-hidden="true">
                      {c.group}
                    </div>
                  )}
                  <div
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    className="palette-item"
                    onMouseMove={() => setActive(i)}
                    onClick={() => runAt(i)}
                  >
                    <Icon name={c.icon} />
                    <span>{c.label}</span>
                    {c.hint && <span className="palette-hint mono">{c.hint}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="palette-foot" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↵</kbd> to open
          </span>
          <span>
            <kbd>esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}
