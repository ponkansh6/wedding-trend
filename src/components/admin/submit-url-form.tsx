"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { detectEmbedProvider } from "@/lib/embed/providers";
import { submitSnsUrl } from "@/app/actions";

type SubmitUrlFormProps = {
  className?: string;
  /** 空状態などの控えめな文脈で使う場合に true。ボタンを一段小さくする。 */
  compact?: boolean;
};

type FormMessage = { text: string; tone: "success" | "error" };

/**
 * Instagram の keyless oEmbed は本文テキストを一切返さない（title/author_name/
 * thumbnail すべて欠落）。ソーステキストが無い場合、バックエンドは要約を
 * 捏造せず `pending` 保存に留め、`needsNote: true` を返す。
 */

/**
 * 速報レーン（sourceType: "sns"）唯一の投入経路。
 * Instagram / TikTok のハッシュタグ巡回は規約・技術上できないため、
 * 運用者が投稿 URL を1件ずつ貼り付けて取り込む導線がレーンの生命線になる。
 */
export function SubmitUrlForm({ className, compact = false }: SubmitUrlFormProps) {
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<FormMessage | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const noteTextareaRef = useRef<HTMLTextAreaElement>(null);
  // 補足メモへフォーカスすべきタイミングを伝える単調増加カウンタ。
  // noteOpen は既に true のまま再度失敗する場合もあるため、真偽値の
  // 変化ではなくこのトークンの変化をトリガーにする。
  const [focusNoteToken, setFocusNoteToken] = useState(0);

  const baseId = useId();
  const inputId = `${baseId}-url`;
  const errorId = `${baseId}-error`;
  const statusId = `${baseId}-status`;
  const noteRegionId = `${baseId}-note-region`;
  const noteInputId = `${baseId}-note-input`;

  const trimmedUrl = url.trim();
  const isInstagramUrl = trimmedUrl !== "" && detectEmbedProvider(trimmedUrl) === "instagram";

  useEffect(() => {
    if (focusNoteToken > 0) {
      noteTextareaRef.current?.focus();
    }
  }, [focusNoteToken]);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isPending) return;

    const trimmed = url.trim();
    if (trimmed === "") {
      setError("URLを入力してください。");
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      setError("正しいURLの形式で入力してください。");
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      setError("httpまたはhttpsで始まるURLを入力してください。");
      return;
    }

    setError(null);
    setMessage(null);
    const trimmedNote = note.trim();
    startTransition(async () => {
      const result = await submitSnsUrl(trimmed, trimmedNote === "" ? undefined : trimmedNote);
      if (result.ok && result.card) {
        toast.success(result.message);
        setMessage({ text: result.message, tone: "success" });
        setUrl("");
        setNote("");
        setNoteOpen(false);
        router.refresh();
      } else {
        // 失敗時は入力を残し、その場で修正できるようにする。
        toast.error(result.message);
        setMessage({ text: result.message, tone: "error" });
        if (result.needsNote) {
          // 本文テキストが無く要約できなかったケース: 補足メモの入力が
          // 実質必須になるので、欄を開いて注意を引く。
          setNoteOpen(true);
          setFocusNoteToken((t) => t + 1);
        }
      }
    });
  };

  const progressMessage = isPending
    ? "公式oEmbedを取得し、AI要約を生成しています。数秒から数十秒かかります。"
    : null;

  return (
    <form
      onSubmit={handleSubmit}
      className={cn("flex flex-col gap-2 text-left", compact && "gap-1.5", className)}
      noValidate
    >
      <label htmlFor={inputId} className="text-[12px] font-medium text-[var(--color-foreground)]">
        SNS投稿のURLを追加
        <span className="ml-1 font-normal text-[var(--color-muted-foreground)]">
          Instagram・TikTok・YouTubeの投稿URL
        </span>
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={inputId}
          name="url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://www.instagram.com/p/..."
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (error) setError(null);
          }}
          disabled={isPending}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : statusId}
          className={cn(
            "h-11 min-w-0 flex-1 rounded-full border bg-[var(--color-surface)] px-4 text-[14px] text-[var(--color-foreground)] transition-colors placeholder:text-[var(--color-muted-foreground)]/70",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background)]",
            "disabled:opacity-60",
            error ? "border-[var(--color-trend)]" : "border-[var(--color-border)]",
          )}
        />
        <Button
          type="submit"
          variant="classic"
          size={compact ? "sm" : "default"}
          disabled={isPending}
          className="shrink-0"
        >
          {isPending ? (
            <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
          ) : (
            <Send className="size-4" aria-hidden />
          )}
          {isPending ? "取り込み中…" : "追加する"}
        </Button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-[12px] text-[var(--color-trend)]">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => setNoteOpen((open) => !open)}
          aria-expanded={noteOpen}
          aria-controls={noteRegionId}
          disabled={isPending}
          className="inline-flex w-fit items-center gap-1 rounded-md py-0.5 text-[12px] font-medium text-[var(--color-muted-foreground)] transition-colors hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background)] disabled:opacity-60"
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
              noteOpen && "rotate-90",
            )}
            aria-hidden
          />
          <span className="underline decoration-dotted underline-offset-4">
            {noteOpen ? "補足メモを閉じる" : "補足メモを追加"}
          </span>
        </button>
        {!noteOpen && isInstagramUrl && (
          <p className="max-w-full text-[11px] leading-jp-body tracking-jp-body text-[var(--color-trend)]">
            Instagramの投稿は本文が取得できません。補足メモの入力をおすすめします。
          </p>
        )}

        <div
          id={noteRegionId}
          className={cn(
            "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
            noteOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="overflow-hidden">
            <div className="flex flex-col gap-1 pt-2">
              <label
                htmlFor={noteInputId}
                className="text-[12px] font-medium text-[var(--color-foreground)]"
              >
                補足メモ（任意）
                <span className="ml-1 font-normal text-[var(--color-muted-foreground)]">
                  投稿の内容を1〜2文で。oEmbedから本文が取れない投稿では、この内容がAI要約のもとになります。
                </span>
              </label>
              <textarea
                ref={noteTextareaRef}
                id={noteInputId}
                name="note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={isPending}
                rows={2}
                maxLength={300}
                placeholder="例: 白ドレスに生花のブーケを合わせた前撮りカット。会場はナチュラル系の一軒家レストラン。"
                className={cn(
                  "min-w-0 resize-none rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-[14px] leading-jp-body text-[var(--color-foreground)] transition-colors placeholder:text-[var(--color-muted-foreground)]/70",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background)]",
                  "disabled:opacity-60",
                )}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 取得中の進捗はここで読み上げる（結果メッセージとは別領域）。 */}
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        aria-busy={isPending}
        className={cn(
          "text-[12px] leading-jp-body tracking-jp-body text-[var(--color-muted-foreground)]",
          !progressMessage && "sr-only",
        )}
      >
        {progressMessage ?? ""}
      </p>

      {/* 取り込み結果はトーストだけでなくここでも常に読み上げ・表示する。
          失敗時はここが「次に何をすべきか」を伝える唯一の恒久的な導線になる。 */}
      {message && (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          aria-live={message.tone === "error" ? "assertive" : "polite"}
          className={cn(
            "rounded-xl px-3 py-2 text-[12px] leading-jp-body tracking-jp-body",
            message.tone === "error"
              ? "border border-[var(--color-trend)]/30 bg-[var(--color-trend-tint-a)]/35 text-[var(--color-foreground)]"
              : "bg-[var(--color-classic-tint-a)]/35 text-[var(--color-foreground)]",
          )}
        >
          {message.text}
        </p>
      )}
    </form>
  );
}
