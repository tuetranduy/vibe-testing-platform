import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = { title: { default: "AI Testing Platform", template: "%s · AI Testing Platform" } };
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="app-header">
          <div className="app-header-inner">
            <a className="brand" href="/">
              AI Testing Platform
            </a>
            <nav aria-label="Main">
              <a href="/runs/new">New test</a>
            </nav>
          </div>
        </header>
        <main id="main" className="page">
          {children}
        </main>
      </body>
    </html>
  );
}
