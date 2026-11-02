import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const securityHeaders = [
  // The site is never meant to be framed (clickjacking).
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  transpilePackages: ["@app/api-client"],
  // The dev server would otherwise write an AGENTS.md into the app.
  agentRules: false,
  // Hides the dev-only "N" badge that sits over the player.
  devIndicators: false,
  images: {
    // TheTVDB art (hero pictures, episode stills) is resized here to the screen it is shown on. The
    // widest size is the 1920 px original, so big and retina screens keep full resolution.
    remotePatterns: [{ protocol: "https", hostname: "artworks.thetvdb.com" }],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920],
    imageSizes: [96, 192, 288, 384],
    qualities: [82],
    formats: ["image/webp"],
    // Catalog art never changes under the same address.
    minimumCacheTTL: 60 * 60 * 24 * 30,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default createNextIntlPlugin()(nextConfig);
