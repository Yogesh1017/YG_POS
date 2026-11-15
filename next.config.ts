import type { NextConfig } from "next";

// The interface is exported as static files and shown inside the desktop app. Every screen is
// client-rendered and talks to the local core; there is no web server and nothing online.
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
