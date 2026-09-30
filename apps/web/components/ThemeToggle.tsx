"use client";

import { useEffect, useState } from "react";
import { applyTheme, readThemePref, THEME_EVENT, type ThemePref } from "../lib/theme";
import { Icon, type IconName } from "./Icon";

const OPTIONS: readonly { value: ThemePref; label: string; icon: IconName }[] = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "system", label: "System", icon: "monitor" },
  { value: "dark", label: "Dark", icon: "moon" },
];

/** Light, system or dark. "System" keeps following the OS while the page is open. */
export function ThemeToggle() {
  // Unknown until mounted: the server cannot see the stored preference.
  const [pref, setPref] = useState<ThemePref | null>(null);

  useEffect(() => {
    setPref(readThemePref());
    const follow = (e: Event) => setPref((e as CustomEvent<ThemePref>).detail);
    window.addEventListener(THEME_EVENT, follow);
    return () => window.removeEventListener(THEME_EVENT, follow);
  }, []);

  useEffect(() => {
    if (pref !== "system" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  return (
    <div role="group" aria-label="Theme" className="theme-toggle">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className="theme-option"
          aria-pressed={pref === o.value}
          title={`${o.label} theme`}
          onClick={() => applyTheme(o.value)}
        >
          <Icon name={o.icon} />
          <span className="visually-hidden">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
