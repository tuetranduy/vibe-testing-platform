"use client";

import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useMemo, useRef, useState } from "react";
import { MAIN_NAV, SETTINGS_NAV } from "../lib/nav";
import { applyTheme } from "../lib/theme";
import { Icon, type IconName } from "./Icon";

type Action = { id: string; group: string; label: string; icon: IconName; hint?: string; run: () => void };

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
  const returnFocus = useRef<HTMLElement | null>(null);

  const commands = useMemo<Action[]>(() => {
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

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setQuery("");
          onClose();
        }
      }}
    >
      <DialogContent
        aria-modal="true"
        showCloseButton={false}
        overlayClassName="z-[60]"
        className="top-[12vh] z-[60] block max-w-lg translate-y-0 overflow-hidden p-0 sm:max-w-lg"
        onOpenAutoFocus={() => { returnFocus.current = document.activeElement as HTMLElement | null; }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">Search or jump to</DialogTitle>
        <DialogDescription className="sr-only">Use the arrow keys to choose a page or action.</DialogDescription>
        <Command
          loop
          label="Search pages and actions"
          filter={(_value, search, keywords) => Number(keywords?.[0]?.toLowerCase().includes(search.trim().toLowerCase()))}
        >
          <CommandInput
            aria-label="Search pages and actions"
            placeholder="Search pages and actions…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList label="Pages and actions">
            <CommandEmpty>Nothing matches “{query}”.</CommandEmpty>
            {["Go to", "Theme"].map((group) => (
              <CommandGroup key={group} heading={group}>
                {commands.filter((command) => command.group === group).map((command) => (
                  <CommandItem
                    key={command.id}
                    value={command.id}
                    keywords={[`${command.label} ${command.hint ?? ""} ${command.group}`]}
                    onSelect={() => {
                      setQuery("");
                      onClose();
                      command.run();
                    }}
                  >
                    <Icon name={command.icon} />
                    <span>{command.label}</span>
                    {command.hint && <CommandShortcut>{command.hint}</CommandShortcut>}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground [&>span]:inline-flex [&>span]:items-center [&>span]:gap-1.5" aria-hidden="true">
            <span><kbd>↑</kbd><kbd>↓</kbd> to move</span>
            <span><kbd>↵</kbd> to open</span>
            <span><kbd>esc</kbd> to close</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
