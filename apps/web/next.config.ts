import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  transpilePackages: ["@platform/contracts"],
  poweredByHeader: false,
  // No other site may frame the UI (clickjacking a "Yes, cancel run" or "Reveal"). Only
  // frame-ancestors: a full CSP would need nonces for Next's inline scripts.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default config;
