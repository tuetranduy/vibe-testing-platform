import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  transpilePackages: ["@platform/contracts"],
  poweredByHeader: false,
};

export default config;
