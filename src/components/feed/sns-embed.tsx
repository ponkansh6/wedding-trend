"use client";

import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import type { EmbedProvider } from "@/lib/types";

declare global {
  interface Window {
    instgrm?: {
      Embeds: { process: () => void };
    };
  }
}

const PROVIDER_SCRIPT: Partial<Record<EmbedProvider, string>> = {
  instagram: "https://www.instagram.com/embed.js",
  tiktok: "https://www.tiktok.com/embed.js",
};

/** レーンごとの想定比率。プロバイダの実サイズに合わせて CLS を最小化する。 */
const PROVIDER_ASPECT: Record<EmbedProvider, string> = {
  instagram: "aspect-[4/5]",
  tiktok: "aspect-[9/16]",
  youtube: "aspect-video",
  none: "aspect-video",
};

/** Instagram / TikTok の埋め込みは白背景を前提にデザインされているため、
 *  ダークテーマでも破綻しないよう「マット紙」に載せて見せる。 */
const NEEDS_LIGHT_MAT: Partial<Record<EmbedProvider, true>> = {
  instagram: true,
  tiktok: true,
};

function ensureProviderScript(
  provider: EmbedProvider,
  onAlreadyLoaded: () => void,
  onError: () => void,
) {
  const src = PROVIDER_SCRIPT[provider];
  if (!src) return;

  const existing = document.querySelector<HTMLScriptElement>(
    `script[src="${src}"]`,
  );
  if (existing) {
    // 既にページ内の別カードが読み込み済み。再スキャンだけ行う。
    onAlreadyLoaded();
    return;
  }

  const script = document.createElement("script");
  script.src = src;
  script.async = true;
  script.addEventListener("load", onAlreadyLoaded);
  script.addEventListener("error", onError);
  document.body.appendChild(script);
}

type SnsEmbedProps = {
  embedProvider: Exclude<EmbedProvider, "none">;
  /**
   * oEmbed から取得済みの HTML。
   * 信頼境界: Instagram / TikTok / YouTube の公式 oEmbed エンドポイントのみを
   * 出所とする文字列（src/lib/embed 側で検証済み）。ユーザー入力は含まれない
   * 前提で dangerouslySetInnerHTML を使用する。
   */
  embedHtml: string;
  /** 埋め込みが失敗した場合に表示する、サムネイル＋リンクボタンの代替 UI */
  fallback: React.ReactNode;
};

export function SnsEmbed({ embedProvider, embedHtml, fallback }: SnsEmbedProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    embedProvider === "youtube" ? "ready" : "loading",
  );

  useEffect(() => {
    if (embedProvider === "youtube") {
      // YouTube の oEmbed は単体の <iframe> を返すためスクリプト不要。
      setStatus("ready");
      return;
    }

    let cancelled = false;
    const markReady = () => {
      if (cancelled) return;
      if (embedProvider === "instagram") {
        window.instgrm?.Embeds.process();
      }
      setStatus("ready");
    };
    const markError = () => {
      if (!cancelled) setStatus("error");
    };

    ensureProviderScript(embedProvider, markReady, markError);

    // スクリプトの読み込み・処理が想定より遅い場合の保険。
    // 埋め込み用の要素が実際に描画されたら早期に確定させる。
    const observer = new MutationObserver(() => {
      if (containerRef.current?.querySelector("iframe")) {
        markReady();
      }
    });
    if (containerRef.current) {
      observer.observe(containerRef.current, { childList: true, subtree: true });
    }
    const fallbackTimer = window.setTimeout(markReady, 4000);

    return () => {
      cancelled = true;
      observer.disconnect();
      window.clearTimeout(fallbackTimer);
    };
  }, [embedProvider]);

  if (status === "error") {
    return <>{fallback}</>;
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "embed-frame relative w-full overflow-hidden rounded-xl",
        PROVIDER_ASPECT[embedProvider],
        NEEDS_LIGHT_MAT[embedProvider] && "bg-white p-2",
      )}
    >
      {status === "loading" && (
        <Skeleton className="absolute inset-0 rounded-xl" />
      )}
      <div
        className={cn(
          "h-full w-full transition-opacity duration-300",
          status === "ready" ? "opacity-100" : "opacity-0",
        )}
        // 信頼境界: 公式 oEmbed エンドポイント由来の HTML のみを注入する。
        dangerouslySetInnerHTML={{ __html: embedHtml }}
      />
    </div>
  );
}
