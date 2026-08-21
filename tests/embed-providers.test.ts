import { describe, expect, it } from "vitest";
import { detectEmbedProvider } from "@/lib/embed/providers";

describe("detectEmbedProvider", () => {
  it("detects Instagram post/reel/tv URLs", () => {
    expect(detectEmbedProvider("https://www.instagram.com/p/ABC123/")).toBe("instagram");
    expect(detectEmbedProvider("https://instagram.com/reel/XYZ789/")).toBe("instagram");
    expect(detectEmbedProvider("https://www.instagram.com/tv/QQQ111/")).toBe("instagram");
  });

  it("detects TikTok video URLs", () => {
    expect(detectEmbedProvider("https://www.tiktok.com/@someuser/video/1234567890")).toBe("tiktok");
  });

  it("detects YouTube watch URLs", () => {
    expect(detectEmbedProvider("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube");
  });

  it("detects youtu.be short links", () => {
    expect(detectEmbedProvider("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
  });

  it("detects YouTube Shorts URLs", () => {
    expect(detectEmbedProvider("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("youtube");
  });

  it("returns none for unsupported hosts", () => {
    expect(detectEmbedProvider("https://example.com/post/1")).toBe("none");
  });

  it("returns none for Instagram profile URLs (not a post)", () => {
    expect(detectEmbedProvider("https://www.instagram.com/someuser/")).toBe("none");
  });

  it("returns none for TikTok URLs without video path", () => {
    expect(detectEmbedProvider("https://www.tiktok.com/@someuser")).toBe("none");
  });

  it("returns none for YouTube URLs without watch or shorts path", () => {
    expect(detectEmbedProvider("https://www.youtube.com/feed/subscriptions")).toBe("none");
  });

  it("returns none for youtu.be with empty path", () => {
    expect(detectEmbedProvider("https://youtu.be/")).toBe("none");
  });
});
