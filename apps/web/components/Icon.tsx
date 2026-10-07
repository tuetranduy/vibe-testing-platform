import type { ReactNode } from "react";

/** Small decorative status icons. Always paired with text; hidden from assistive tech. */
export type IconName =
  | "check"
  | "current"
  | "pending"
  | "skip"
  | "stop"
  | "warning"
  | "error"
  | "info"
  | "lock"
  | "image"
  | "pass"
  | "fail"
  | "blocked"
  | "unknown"
  | "chevron"
  | "file"
  | "video"
  | "download"
  | "external"
  | "code"
  | "note"
  | "x"
  | "plus"
  | "search"
  | "globe"
  | "next"
  | "arrow"
  | "shield"
  | "restart"
  | "copy"
  | "data"
  | "sliders"
  | "user"
  | "key"
  | "chart"
  | "print"
  | "layers"
  | "clock"
  | "menu"
  | "sidebar"
  | "sun"
  | "moon"
  | "monitor"
  | "activity"
  | "gear"
  | "logout"
  | "command"
  | "sparkle"
  | "gauge";

const PATHS: Record<IconName, ReactNode> = {
  check: <path d="M4 10.5l4 4 8-9" />,
  current: (
    <>
      <circle cx="10" cy="10" r="7" />
      <circle cx="10" cy="10" r="3" fill="currentColor" stroke="none" />
    </>
  ),
  pending: <circle cx="10" cy="10" r="7" />,
  skip: <path d="M4 6l5 4-5 4M11 6l5 4-5 4" />,
  // A stop sign's square, so a cancelled run never looks like a failed one (a circled cross).
  stop: <rect x="5" y="5" width="10" height="10" rx="2" />,
  warning: (
    <>
      <path d="M10 3l7.5 13h-15z" />
      <path d="M10 8v3.5M10 14v.01" />
    </>
  ),
  error: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6.5v4.5M10 13.5v.01" />
    </>
  ),
  info: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 9v4.5M10 6.5v.01" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="9" width="11" height="8" rx="1.5" />
      <path d="M7 9V6.5a3 3 0 016 0V9" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="1.5" />
      <path d="M3 13l4-4 3 3 2-2 5 5" />
    </>
  ),
  // Criterion statuses / verdicts: four distinct shapes, so status never depends on color alone.
  pass: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M6.8 10.2l2.2 2.3 4.3-4.8" />
    </>
  ),
  fail: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M7.6 7.6l4.8 4.8M12.4 7.6l-4.8 4.8" />
    </>
  ),
  blocked: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M5.1 14.9l9.8-9.8" />
    </>
  ),
  unknown: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M7.9 7.9a2.2 2.2 0 114 1.2c-.7.6-1.9 1-1.9 2.2M10 13.9v.01" />
    </>
  ),
  chevron: <path d="M6.5 8l3.5 3.5L13.5 8" />,
  file: (
    <>
      <path d="M5 2.5h6.5l3.5 3.5v11.5H5z" />
      <path d="M11.5 2.5V6H15" />
    </>
  ),
  video: (
    <>
      <rect x="2.5" y="5" width="11" height="10" rx="1.5" />
      <path d="M13.5 9l4-2.5v7l-4-2.5" />
    </>
  ),
  download: <path d="M10 3v10M6 9l4 4 4-4M4 16.5h12" />,
  external: <path d="M11.5 3.5h5v5M16.5 3.5L9 11M14 12.5v4H3.5V6h4" />,
  code: <path d="M7 6l-4 4 4 4M13 6l4 4-4 4" />,
  note: <path d="M3.5 4h13v9H9l-4 3.5V13H3.5z" />,
  x: <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />,
  plus: <path d="M10 4.5v11M4.5 10h11" />,
  search: (
    <>
      <circle cx="9" cy="9" r="5.5" />
      <path d="M13 13l3.5 3.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M3 10h14M10 3a11 11 0 0 1 0 14M10 3a11 11 0 0 0 0 14" />
    </>
  ),
  next: <path d="M8 6l4 4-4 4" />,
  arrow: <path d="M4 10h12M11.5 5.5L16 10l-4.5 4.5" />,
  shield: (
    <>
      <path d="M10 17.5s6-2.8 6-7.6V5l-6-2.3L4 5v4.9c0 4.8 6 7.6 6 7.6z" />
      <path d="M7.4 10.2l1.8 1.8 3.5-3.7" />
    </>
  ),
  restart: (
    <>
      <path d="M3.5 10a6.5 6.5 0 1 0 1.9-4.6L3.5 7.3" />
      <path d="M3.5 3.5v3.8h3.8" />
    </>
  ),
  copy: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M13 7V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H7" />
    </>
  ),
  data: (
    <>
      <ellipse cx="10" cy="5" rx="6" ry="2.2" />
      <path d="M4 5v10c0 1.2 2.7 2.2 6 2.2s6-1 6-2.2V5M4 10c0 1.2 2.7 2.2 6 2.2s6-1 6-2.2" />
    </>
  ),
  sliders: (
    <>
      <path d="M3.5 6h8M15 6h1.5M3.5 14h3M10 14h6.5" />
      <circle cx="13" cy="6" r="1.8" />
      <circle cx="8" cy="14" r="1.8" />
    </>
  ),
  user: (
    <>
      <circle cx="10" cy="7" r="3.2" />
      <path d="M3.8 16.5c.9-3 3.3-4.6 6.2-4.6s5.3 1.6 6.2 4.6" />
    </>
  ),
  key: (
    <>
      <circle cx="6.5" cy="13.5" r="3" />
      <path d="M8.7 11.3L16 4M13.5 6.5l2 2M11.5 8.5l1.5 1.5" />
    </>
  ),
  chart: <path d="M3.5 16.5h13M5.5 13.5v-4M9 13.5V6M12.5 13.5v-6M16 13.5V4" />,
  print: (
    <>
      <path d="M6 7.5V3.5h8v4M6 13.5H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-2" />
      <rect x="6" y="11" width="8" height="5.5" rx="0.5" />
    </>
  ),
  layers: <path d="M10 3l7 3.5-7 3.5-7-3.5zM3 10l7 3.5 7-3.5M3 13.5L10 17l7-3.5" />,
  clock: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6.5V10l2.5 1.5" />
    </>
  ),
  menu: <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />,
  sidebar: (
    <>
      <rect x="3" y="3.5" width="14" height="13" rx="2" />
      <path d="M8 3.5v13M5.5 7h0M11.5 8.5L10 10l1.5 1.5" />
    </>
  ),
  sun: (
    <>
      <circle cx="10" cy="10" r="3.2" />
      <path d="M10 2.5v1.6M10 15.9v1.6M2.5 10h1.6M15.9 10h1.6M4.7 4.7l1.1 1.1M14.2 14.2l1.1 1.1M4.7 15.3l1.1-1.1M14.2 5.8l1.1-1.1" />
    </>
  ),
  moon: <path d="M16 12.2A6.5 6.5 0 0 1 7.8 4a6.5 6.5 0 1 0 8.2 8.2z" />,
  monitor: (
    <>
      <rect x="2.5" y="3.5" width="15" height="10" rx="1.5" />
      <path d="M7 17h6M10 13.5V17" />
    </>
  ),
  activity: <path d="M2.5 10h3l2-5 4 10 2-5h4" />,
  sparkle: <path d="M10 2.5l1.7 4.6 4.8 1.9-4.8 1.9L10 15.5l-1.7-4.6L3.5 9l4.8-1.9zM15.5 13.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />,
  gauge: (
    <>
      <path d="M3.3 14.5a7.5 7.5 0 1113.4 0" />
      <path d="M10 11l3.2-3.6" />
      <circle cx="10" cy="11.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  gear: (
    <>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
    </>
  ),
  logout: <path d="M8 3.5H5A1.5 1.5 0 0 0 3.5 5v10A1.5 1.5 0 0 0 5 16.5h3M12.5 13.5L16 10l-3.5-3.5M16 10H7.5" />,
  command: (
    <path d="M7.5 7.5h5v5h-5zM7.5 7.5V5.8a2.2 2.2 0 1 0-2.2 2.2h2.2M12.5 7.5V5.8a2.2 2.2 0 1 1 2.2 2.2h-2.2M7.5 12.5v1.7a2.2 2.2 0 1 1-2.2-2.2h2.2M12.5 12.5v1.7a2.2 2.2 0 1 0 2.2-2.2h-2.2" />
  ),
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      {PATHS[name]}
    </svg>
  );
}
