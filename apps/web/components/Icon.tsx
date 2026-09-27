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
  | "sliders";

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
