import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { AppNav } from "../components/AppNav";
import "./globals.css";

const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = { title: { default: "AI Testing Platform", template: "%s · AI Testing Platform" } };
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0f17" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="app-header">
          <div className="app-header-inner">
            <a className="brand" href="/">
              <svg className="brand-mark" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" focusable="false">
                <rect width="28" height="28" rx="8" fill="currentColor" />
                <path
                  d="M8.5 14.5l3.5 3.5 7.5-8"
                  fill="none"
                  stroke="var(--primary-contrast)"
                  strokeWidth="2.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              AI Testing Platform
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
