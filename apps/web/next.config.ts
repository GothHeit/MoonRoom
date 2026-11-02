import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Everything the browser loads comes from this origin (the API and video go through /api/proxy),
// except catalog pictures. Inline scripts stay allowed because Next.js inlines its bootstrap; the
// policy still stops injected markup from loading outside scripts, framing, posting forms or
// sending data anywhere but here. The dev server needs eval and a websocket, so it gets only the
// framing rule.
const contentSecurityPolicy = [
  "default-src 'self'",
  // wasm: the subtitle renderer (JASSUB) compiles WebAssembly in its worker.
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // Posters and avatars come from MAL's and other catalogs' CDNs.
  "img-src 'self' data: blob: https:",
  // hls.js feeds the video element through MediaSource (blob:).
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // The site is never meant to be framed (clickjacking).
  "frame-ancestors 'none'",
].join("; ");

const production = process.env.NODE_ENV === "production";

const securityHeaders = [
  { key: "Content-Security-Policy", value: production ? contentSecurityPolicy : "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" },
  // Pages opened from here (MAL's consent page) can't reach back into this window.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
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
