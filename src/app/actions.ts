"use server";

import { z } from "zod";
import { detectEmbedProvider } from "@/lib/embed/providers";
import { runIngest } from "@/lib/pipeline/ingest";
import { runSubmitUrl } from "@/lib/pipeline/submit-url";
import type { FeedCard } from "@/lib/types";

/**
 * 収集トリガーの実行結果。クライアントコンポーネントへ渡るため
 * すべてシリアライズ可能な値のみで構成する。
 */
export type IngestResult = {
  ok: boolean;
  fetched: number;
  inserted: number;
  curated: number;
  skipped: number;
  errors: string[];
};

export type SubmitUrlResult = {
  ok: boolean;
  /** 画面にそのまま表示できる日本語メッセージ。 */
  message: string;
  card: FeedCard | null;
  /**
   * 補足メモの入力を促すべき失敗かどうか。
   *
   * UI はこのフラグだけを見て復帰フロー（補足メモ欄を開いてフォーカス）を
   * 判断すること。`message` の文面を部分一致で判定してはならない。
   * 文言の変更で無言に壊れるため。
   */
  needsNote: boolean;
};

/**
 * 管理操作（収集トリガー・URL 投入）が有効かどうか。
 *
 * 本番では既定で無効。UI を隠すだけでは防御にならないため、
 * 各 Server Action 自身も実行時に同じ判定を行う。
 */
export async function adminControlsEnabled(): Promise<boolean> {
  return process.env.NODE_ENV !== "production" || process.env.ENABLE_ADMIN_CONTROLS === "1";
}

/** 管理操作が無効な場合に画面へそのまま表示する文言。 */
const ADMIN_DISABLED_MESSAGE = "この操作は現在無効になっています。管理者にお問い合わせください。";

/**
 * `runSubmitUrl` が `"needs_source_text"` を返した場合に画面へそのまま表示する文言。
 * Instagram のキーなし oEmbed はキャプション本文を返さないため、原文が無いまま
 * AI に要約させることができない（=させてはいけない）。埋め込み自体は保存済みなので、
 * 運営が「補足メモ」を添えて再投入すれば oEmbed を取り直さずに公開できる。
 */
const NEEDS_SOURCE_TEXT_MESSAGE =
  "この投稿は本文を取得できませんでした。Instagramの埋め込みAPIはキャプション文を返さないため、AIが要約する元の文章が存在しません。埋め込み自体は保存済みです。投稿フォームの「補足メモ」欄に投稿内容の要点を入力し、再度お試しください。";

/** RSS 巡回パイプラインを実行する。 */
export async function triggerIngest(): Promise<IngestResult> {
  // UI 側でボタンを隠していても、Server Action は直接叩けるため必ず再検証する。
  if (!(await adminControlsEnabled())) {
    return {
      ok: false,
      fetched: 0,
      inserted: 0,
      curated: 0,
      skipped: 0,
      errors: [ADMIN_DISABLED_MESSAGE],
    };
  }

  try {
    const summary = await runIngest();
    return { ok: true, ...summary };
  } catch (err) {
    console.error("[actions] triggerIngest failed:", err);
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      fetched: 0,
      inserted: 0,
      curated: 0,
      skipped: 0,
      errors: [message],
    };
  }
}

/**
 * SNS 投稿 URL の入力検証。
 * - 構文的に妥当な URL であること（`javascript:` 等の非 http(s) スキームを拒否）
 * - `detectEmbedProvider` で既知のプロバイダ（Instagram / TikTok / YouTube）に
 *   解決できること
 */
const SnsUrlSchema = z
  .string()
  .trim()
  .min(1, "URLを入力してください。")
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "有効なURL形式ではありません。" });
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      ctx.addIssue({
        code: "custom",
        message: "http または https で始まるURLを指定してください。",
      });
      return;
    }
    if (detectEmbedProvider(value) === "none") {
      ctx.addIssue({
        code: "custom",
        message:
          "対応していないURLです。Instagram / TikTok / YouTube の投稿URLを指定してください。",
      });
    }
  });

/**
 * SNS 投稿 URL を 1 件取り込む。
 * `note` は運営が添える補足メモ（省略可）。空白のみの入力は「補足なし」として扱う。
 */
export async function submitSnsUrl(url: string, note?: string): Promise<SubmitUrlResult> {
  // UI 側でボタンを隠していても、Server Action は直接叩けるため必ず再検証する。
  if (!(await adminControlsEnabled())) {
    return { ok: false, message: ADMIN_DISABLED_MESSAGE, card: null, needsNote: false };
  }

  const parsed = SnsUrlSchema.safeParse(url);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "URLの形式が正しくありません。";
    return { ok: false, message, card: null, needsNote: false };
  }

  const trimmedNote = note?.trim();
  const noteArg = trimmedNote && trimmedNote !== "" ? trimmedNote : undefined;

  try {
    const outcome = await runSubmitUrl(parsed.data, noteArg);

    if (outcome.reason === "needs_source_text") {
      return { ok: false, message: NEEDS_SOURCE_TEXT_MESSAGE, card: null, needsNote: true };
    }

    if (!outcome.ok) {
      const message =
        outcome.reason === "invalid_url"
          ? "有効なURLではありません。"
          : "投稿の保存に失敗しました。時間をおいて再度お試しください。";
      return { ok: false, message, card: null, needsNote: false };
    }

    const message =
      outcome.reason === "needs_review"
        ? "投稿を取り込みました。AIによる見出し・要約の生成に失敗したため、内容の確認をおすすめします。"
        : "投稿を取り込みました。";
    return { ok: true, message, card: outcome.card, needsNote: false };
  } catch (err) {
    console.error("[actions] submitSnsUrl failed:", err);
    return {
      ok: false,
      message: "投稿の取り込み中にエラーが発生しました。時間をおいて再度お試しください。",
      card: null,
      needsNote: false,
    };
  }
}
