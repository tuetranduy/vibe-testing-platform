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
  | "note";

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
  stop: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M7.5 7.5l5 5M12.5 7.5l-5 5" />
    </>
  ),
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
