import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["@libsql/client"],
  experimental: {
    optimizePackageImports: ["@google/generative-ai", "lucide-react"],
  },
  images: {
    remotePatterns: [
      // Instagram / Facebook CDN（サムネイル・oEmbed 画像）
      { protocol: "https", hostname: "*.cdninstagram.com" },
      { protocol: "https", hostname: "scontent*.fbcdn.net" },
      // TikTok CDN（サムネイル）
      { protocol: "https", hostname: "p16-sign*.tiktokcdn*.com" },
      { protocol: "https", hostname: "p*.tiktokcdn-*.com" },
      // YouTube サムネイル
      { protocol: "https", hostname: "i.ytimg.com" },
      // Ameba ブログ
      { protocol: "https", hostname: "ameblo.jp" },
      { protocol: "https", hostname: "stat.ameba.jp" },
      // note.com
      { protocol: "https", hostname: "assets.st-note.com" },
      // はてなブックマーク OGP 画像
      { protocol: "https", hostname: "*.st-hatena.com" },
      { protocol: "https", hostname: "s.tgstc.com" },
    ],
  },
};

export default nextConfig;
