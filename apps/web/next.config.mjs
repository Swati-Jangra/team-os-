import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const API_URL = process.env.API_URL ?? 'http://localhost:4000';

const isProd = process.env.NODE_ENV === 'production';
// HSTS / upgrade-insecure-requests only make sense when served over https. The browser E2E serves the production build over
// plain http://localhost and builds with ALLOW_HTTP=1; never set it for a real deployment.
const httpsOnly = isProd && process.env.ALLOW_HTTP !== '1';

// Content-Security-Policy. Everything is same-origin (the API is proxied through this origin), so
// connect-src is 'self'. Next.js emits inline bootstrap scripts, hence 'unsafe-inline' for scripts —
// a nonce-based policy would force every page to render dynamically (documented as a known gap).
// 'unsafe-eval' is needed only by the dev server's hot reloading.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(httpsOnly ? ['upgrade-insecure-requests'] : []),
].join('; ');

const nextConfig = {
  output: 'standalone',
  // monorepo: trace files from the repo root so workspace packages are included in the standalone bundle
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@teamos/ui'],
  // Same-origin proxy: the browser only talks to the web origin, so the httpOnly session cookie
  // and the CSRF cookie belong to one origin and no CORS is needed.
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${API_URL}/api/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Content-Security-Policy', value: csp },
          { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), microphone=(), payment=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          ...(httpsOnly ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
        ],
      },
    ];
  },
};

export default nextConfig;
