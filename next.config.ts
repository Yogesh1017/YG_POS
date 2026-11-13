import type { NextConfig } from "next";

// The app is exported as static files: every screen is client-rendered and talks to
// Supabase directly (RLS + RPC). No Node server is needed at runtime, which is what lets
// the service worker serve the whole app while the shop is offline.
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
