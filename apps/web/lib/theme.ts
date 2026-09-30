/** The colour theme: a preference ("system" follows the OS) resolved to `data-theme` on <html>. */
export type ThemePref = "light" | "system" | "dark";

export const THEME_KEY = "theme";
export const SIDEBAR_KEY = "sidebar";
/** Fired on `window` whenever the preference changes, so every control showing it can follow. */
export const THEME_EVENT = "themechange";

/**
 * Runs in <head> before first paint (app/layout.tsx), so a light-theme user never sees a dark flash.
 * Mirrors `readThemePref` and `applyTheme`; storage may be unavailable, and then the default stands.
 */
export const THEME_SCRIPT = `(function(){try{var d=document.documentElement,s=localStorage,p=s.getItem("${THEME_KEY}");if(p!=="light"&&p!=="system")p="dark";var l=p==="light"||(p==="system"&&matchMedia("(prefers-color-scheme: light)").matches);d.setAttribute("data-theme",l?"light":"dark");d.setAttribute("data-theme-pref",p);if(s.getItem("${SIDEBAR_KEY}")==="collapsed")d.setAttribute("data-sidebar","collapsed")}catch(e){}})();`;

function prefersLight(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches;
}

export function readThemePref(): ThemePref {
  const p = document.documentElement.getAttribute("data-theme-pref");
  return p === "light" || p === "system" ? p : "dark";
}

/** Applies `pref` to <html>, remembers it, and tells the other theme controls. */
export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  const light = pref === "light" || (pref === "system" && prefersLight());
  root.setAttribute("data-theme", light ? "light" : "dark");
  root.setAttribute("data-theme-pref", pref);
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // Private windows and blocked storage: the theme still applies for this page.
  }
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: pref }));
}

export function isSidebarCollapsed(): boolean {
  return document.documentElement.getAttribute("data-sidebar") === "collapsed";
}

export function setSidebarCollapsed(collapsed: boolean): void {
  const root = document.documentElement;
  if (collapsed) root.setAttribute("data-sidebar", "collapsed");
  else root.removeAttribute("data-sidebar");
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded");
  } catch {
    // As above: the choice holds until the page reloads.
  }
}
