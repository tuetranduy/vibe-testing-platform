import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { AppNav } from "../components/AppNav";
import "./globals.css";

const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-display", display: "swap", axes: ["opsz"] });
const sans = Geist({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = { title: { default: "AI Testing Platform", template: "%s · AI Testing Platform" } };
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1b1a1f" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="app-header">
          <div className="app-header-inner">
            <a className="brand" href="/">
              {/* A viewfinder around a check: the platform looks at a page and confirms what it sees. */}
              <svg className="brand-mark" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" focusable="false">
                <rect width="32" height="32" rx="9" fill="var(--primary)" />
                <path
                  d="M9 13v-3a1 1 0 0 1 1-1h3M19 9h3a1 1 0 0 1 1 1v3M23 19v3a1 1 0 0 1-1 1h-3M13 23h-3a1 1 0 0 1-1-1v-3"
                  fill="none"
                  stroke="var(--primary-contrast)"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
                <path
                  d="M12.4 16.2l2.5 2.5 4.8-5.1"
                  fill="none"
                  stroke="var(--brand-check)"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="brand-name">AI Testing Platform</span>
            </a>
            <AppNav />
          </div>
        </header>
        <main id="main" className="page">
          {children}
        </main>
      </body>
    </html>
  );
}
