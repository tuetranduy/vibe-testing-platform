import { useId } from "react";

/** A viewfinder around a check: the platform looks at a page and confirms what it sees. */
export function BrandMark({ size = 28 }: { size?: number }) {
  const id = useId();
  const fill = `brand-fill-${id}`;
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5b7cff" />
          <stop offset="1" stopColor="#2a4fe0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${fill})`} />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill="none" stroke="rgb(255 255 255 / 0.22)" />
      <path
        d="M9 13v-3a1 1 0 0 1 1-1h3M19 9h3a1 1 0 0 1 1 1v3M23 19v3a1 1 0 0 1-1 1h-3M13 23h-3a1 1 0 0 1-1-1v-3"
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path d="M12.4 16.2l2.5 2.5 4.8-5.1" fill="none" stroke="#67e8f9" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Brand({ className = "brand" }: { className?: string }) {
  return (
    <a className={className} href="/">
      <BrandMark />
      <span className="brand-name">AI Testing Platform</span>
    </a>
  );
}
