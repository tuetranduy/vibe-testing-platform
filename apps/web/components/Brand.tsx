/** A viewfinder around a check: the platform looks at a page and confirms what it sees. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="9" fill="var(--primary)" />
      <path
        d="M9 13v-3a1 1 0 0 1 1-1h3M19 9h3a1 1 0 0 1 1 1v3M23 19v3a1 1 0 0 1-1 1h-3M13 23h-3a1 1 0 0 1-1-1v-3"
        fill="none"
        stroke="var(--primary-foreground)"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path d="M12.4 16.2l2.5 2.5 4.8-5.1" fill="none" stroke="var(--primary-foreground)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
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
