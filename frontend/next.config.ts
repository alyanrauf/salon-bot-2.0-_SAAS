import type { NextConfig } from "next";

const backendUrl = process.env.BACKEND_URL || "http://localhost:3000";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // Browser navigations to the old Express HTML routes → Next.js pages
      // `sec-fetch-mode: navigate` is set by browsers for URL/link navigation;
      // fetch() API calls use `cors` so POST /salon-admin/login still hits Express.
      {
        source: "/salon-admin/login",
        has: [{ type: "header", key: "sec-fetch-mode", value: "navigate" }],
        destination: "/login",
        permanent: false,
      },
      {
        source: "/salon-admin/dashboard",
        has: [{ type: "header", key: "sec-fetch-mode", value: "navigate" }],
        destination: "/dashboard",
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/salon-admin/:path*",
        destination: `${backendUrl}/salon-admin/:path*`,
      },
      {
        source: "/super-admin/:path*",
        destination: `${backendUrl}/super-admin/:path*`,
      },
      {
        source: "/widget/:path*",
        destination: `${backendUrl}/widget/:path*`,
      },
      {
        source: "/salon-config/:path*",
        destination: `${backendUrl}/salon-config/:path*`,
      },
    ];
  },
};

export default nextConfig;
