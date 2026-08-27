import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["@libsql/client"],
  experimental: {
    optimizePackageImports: ["@google/generative-ai", "lucide-react"],
  },
};

export default nextConfig;
