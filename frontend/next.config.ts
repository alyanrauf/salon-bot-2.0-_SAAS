import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/salon-admin/:path*",
        destination: "http://localhost:3000/salon-admin/:path*",
      },
      {
        source: "/super-admin/:path*",
        destination: "http://localhost:3000/super-admin/:path*",
      },
      {
        source: "/widget/:path*",
        destination: "http://localhost:3000/widget/:path*",
      },
    ];
  },
};

export default nextConfig;
