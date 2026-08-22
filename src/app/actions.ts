"use server";

import { z } from "zod";
import { detectEmbedProvider } from "@/lib/embed/providers";
import {
  acquireIngestLease,
  claimIngestSlot,
  getCooldownUntil,
  releaseIngestLease,
} from "@/lib/pipeline/cooldown";
import { runIngest } from "@/lib/pipeline/ingest";
import { runSubmitUrl } from "@/lib/pipeline/submit-url";
import type { FeedCard } from "@/lib/types";

/**
 * 収集トリガーの実行結果。クライアントコンポーネントへ渡るため
 * すべてシリアライズ可能な値のみで構成する。
 */
export type IngestResult = {
  /** 収集が実行され、かつ成功したか。実行を見送った場合（`ran: false`）も false。 */
  ok: boolean;
  /**
   * 今回のこの呼び出しで実際に `runIngest()` を実行したかどうか。
   *
   * `false` はクールダウン中で見送ったことを意味する（エラーではない）。
   * `ok` とは独立したフィールドであり、これを分けているのは
   * 「実行したが失敗した」（`ran: true, ok: false`）と「実行しなかった」
   * （`ran: false, ok: false`）を呼び出し側が区別できるようにするため。
   * `cooldownUntil` は実行の有無にかかわらず値が入るため、
   * 「実行されなかった」の判定には `cooldownUntil` の真偽ではなく
   * 必ずこの `ran` を使うこと。
   */
  ran: boolean;
  /**
   * 別の収集処理（公開ボタンの別呼び出し、または Cron 経路）が実行中で、
   * 今回の呼び出しが弾かれた場合に true。
   *
   * `busy: true` のとき `ran` は必ず false（＝実行権の奪取より前で弾かれるため
   * `claimIngestSlot()` にすら到達しない）。UI はこのフラグを見て
   * 「クールダウン中」とは異なるメッセージ（例:「他の収集が実行中です」）を
   * 出し分けること。クールダウン中の見送り（`ran: false, busy: false`）とは
   * 区別されるので、`ran` の false だけで判定しないこと。
   */
  busy: boolean;
  fetched: number;
  inserted: number;
  curated: number;
  skipped: number;
  errors: string[];
  /**
   * 次に実行可能になる時刻（ISO8601 文字列）。
   *
   * `busy: false` のときは `ran` の値に関わらず、この呼び出し時点で判明して
   * いるクールダウン満了時刻が常に入る。実行した場合（`ran: true`、成功・
   * 失敗いずれも）は「今回消費した枠」の満了時刻、見送った場合
   * （`ran: false`）は「既存の枠」の満了時刻。null になるのは、クールダウンの
   * 状態を確定できなかった場合のみ（実質的に発生しない）。
   *
   * `busy: true` のときは lease 取得より前で弾かれているため、この値は
   * あくまで参考情報（現在クールダウン中かどうか）であり、クールダウン中
   * でなければ普通に null になる。
   *
   * 「今すぐ実行可能か」を知りたい場合は、この値ではなく
   * `getIngestCooldown()` の戻り値を使うこと（意味が異なる）。
   */
  cooldownUntil: string | null;
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

/**
 * 収集ボタンの初期描画用。実行はせず、現在のクールダウン状態のみを返す
 * （クールダウン中でなければ `cooldownUntil: null`）。
 *
 * `triggerIngest()` が返す `IngestResult.cooldownUntil` とは null の意味が
 * 異なる点に注意: こちらは「今このボタンを押せるか」の事前確認であり、
 * 押せるなら null。`triggerIngest()` 側は実行権を奪取した時点（＝押した結果）
 * を表すため、成功・失敗を問わず実行した場合は null にならない。
 */
export async function getIngestCooldown(): Promise<{ cooldownUntil: string | null }> {
  return { cooldownUntil: await getCooldownUntil() };
}

/**
 * 収集処理が例外を投げた場合に公開面へそのまま返す固定文言。
 *
 * Gemini SDK / libSQL / undici 等が投げる例外の `message` にはホスト名・URL・
 * リクエスト断片が混ざり得るため、公開ページ（無認証の誰でも見える面）には
 * 絶対に生の例外メッセージを出さない。実際の例外は console.error でサーバー
 * ログにのみ出力する。
 */
const INGEST_ERROR_MESSAGE = "収集処理でエラーが発生しました。時間をおいてお試しください。";

/**
 * `runIngest()` が返す `summary.errors`（ソースごとの取得・キュレーション
 * 失敗メッセージ）を公開面向けにサニタイズする。
 *
 * `src/lib/pipeline/ingest.ts` は編集対象外のため、そこが生成する各要素
 * （ソース ID・LLM 例外メッセージ等を含みうる）をここで安全な文言に置換する。
 * 原文は console.error でサーバーログにのみ残し、公開面には件数のみを返す。
 */
function sanitizeIngestErrors(rawErrors: string[]): string[] {
  if (rawErrors.length === 0) return [];
  console.error("[actions] triggerIngest: runIngest reported per-source errors:", rawErrors);
  return [`一部のソースを取得できませんでした（${rawErrors.length}件）`];
}

/**
 * lease / cooldown の取得（＝ `config` テーブルへの読み書き）自体が例外を
 * 投げた場合に返す `IngestResult`。
 *
 * `acquireIngestLease()` / `claimIngestSlot()` はどちらも書き込み経路
 * （`src/lib/db/repository.ts` の `writeConfigValue` 系）を通るため、
 * 意図的に fail-closed（＝例外を握りつぶさない。詳細は `writeConfigValue`
 * の JSDoc）。典型的には `config` テーブルが未作成の環境（マイグレーション
 * 未適用の本番、smoke test の空 DB 等）でここに来る。「状態を確定できな
 * かった」ケースなので `cooldownUntil: null` を返す（`IngestResult.cooldownUntil`
 * の JSDoc「null になるのはクールダウンの状態を確定できなかった場合のみ」と
 * 整合する）。`runIngest()` を一切呼んでいないので `ran: false`。
 */
function ingestUnavailableResult(): IngestResult {
  return {
    ok: false,
    ran: false,
    busy: false,
    fetched: 0,
    inserted: 0,
    curated: 0,
    skipped: 0,
    errors: [INGEST_ERROR_MESSAGE],
    cooldownUntil: null,
  };
}

/**
 * RSS 巡回パイプラインを実行する公開 Server Action。
 *
 * 収集ボタンは無認証で本番の公開トップページに置かれる方針のため、
 * `adminControlsEnabled()` によるガードは行わない（`submitSnsUrl` とは
 * 異なり、意図的に誰でも呼び出せる）。代わりに 2 段の防御を DB 側で必ず
 * 強制する:
 *
 * 1. **lease（排他ロック、全経路共通）**: `acquireIngestLease()` が失敗したら
 *    ＝別の経路（Cron を含む）が実行中ということなので、`runIngest()` を
 *    呼ばずに `busy: true` を返す。
 * 2. **cooldown（レートリミット、この公開ボタン経路のみ）**: lease を取得した
 *    後、`claimIngestSlot()` が 4 時間のグローバルクールダウンを DB 側で
 *    原子的に強制する。クールダウン中であれば lease を解放し、`runIngest()`
 *    を呼ばずに待機状態を返す。
 *
 * 両方を突破した場合のみ `last_ingest_at` を実行開始時刻で確定させた上で
 * `runIngest()` を実行し、成功・失敗いずれの場合も `finally` で必ず lease を
 * 解放する（呼び忘れると次の実行が `INGEST_LEASE_TTL_MS` の間ブロックされる）。
 *
 * lease/cooldown の取得自体が例外を投げた場合（§ `ingestUnavailableResult`）も、
 * この Server Action は決して未処理例外で落とさず `IngestResult` を返す。
 */
export async function triggerIngest(): Promise<IngestResult> {
  const now = new Date();

  // 1. lease（排他ロック）取得。全経路（この公開ボタン経路・Cron）が対象。
  // acquireIngestLease() は fail-closed な書き込み経路を通るため例外を投げ得る
  // （典型例: config テーブル未作成）。ここで確実に catch し、生の例外を
  // サーバーログにのみ残した上で安全な IngestResult を返す。
  let leaseAcquired: boolean;
  try {
    leaseAcquired = await acquireIngestLease(now);
  } catch (err) {
    console.error("[actions] triggerIngest: acquireIngestLease failed:", err);
    return ingestUnavailableResult();
  }

  if (!leaseAcquired) {
    // busy: true は「別の収集処理が実行中」を表す。クールダウンとは異なる
    // 概念なので errors は空のまま、cooldownUntil は現在のクールダウン状態
    // （クールダウン中でなければ null）を参考情報として添える。
    // getCooldownUntil() は読み取り専用でフェイルソフト（例外を投げない）
    // ため、ここでは try/catch は不要。
    const cooldownUntil = await getCooldownUntil(now);
    return {
      ok: false,
      ran: false,
      busy: true,
      fetched: 0,
      inserted: 0,
      curated: 0,
      skipped: 0,
      errors: [],
      cooldownUntil,
    };
  }

  // 2. cooldown（レートリミット）判定。この公開ボタン経路のみが評価する
  // （Cron 経路はこの評価を免除される）。claimIngestSlot() は「クールダウン中
  // でなければ last_ingest_at を実行開始時刻に更新する」ところまでを原子的に
  // 行う。lease 同様、書き込み経路を通るため fail-closed（例外を投げ得る）。
  // ここに到達した時点で lease は既に取得済みなので、例外時は解放してから返す
  // （解放そのものが失敗しても、この Server Action は未処理例外で落ちない）。
  let claim: Awaited<ReturnType<typeof claimIngestSlot>>;
  try {
    claim = await claimIngestSlot(now);
  } catch (err) {
    console.error("[actions] triggerIngest: claimIngestSlot failed:", err);
    try {
      await releaseIngestLease(now);
    } catch (releaseErr) {
      console.error(
        "[actions] triggerIngest: releaseIngestLease failed after claimIngestSlot error:",
        releaseErr,
      );
    }
    return ingestUnavailableResult();
  }

  if (!claim.claimed) {
    // クールダウン中で見送る場合は lease を保持し続けない（次の呼び出しを
    // ブロックしないよう即座に解放する）。
    await releaseIngestLease(now);
    // クールダウンはエラーではなく正常な待機状態として表現する（errors は空のまま）。
    // ran: false は「今回この呼び出しでは runIngest() を実行しなかった」ことを表す。
    // UI 側はこの ran だけを見送り判定に使う契約であり、cooldownUntil の真偽では
    // 判定しない（cooldownUntil は実行有無に関わらず常に値が入るため）。
    return {
      ok: false,
      ran: false,
      busy: false,
      fetched: 0,
      inserted: 0,
      curated: 0,
      skipped: 0,
      errors: [],
      cooldownUntil: claim.cooldownUntil,
    };
  }

  // ここに到達した時点で claim.claimed === true、つまり claimIngestSlot() が
  // last_ingest_at を実行開始時刻に更新済みで、実行権の枠を既に消費している。
  // claim.cooldownUntil は「今回の奪取によって新たに開始したクールダウン」の
  // 満了時刻であり、この後 runIngest() が成功しようが失敗しようが変わらない
  // （枠を返却しない設計のため）。そのため成功時・失敗時のどちらの応答にも
  // claim.cooldownUntil をそのまま含める。null を返すと、UI が「今すぐ実行可能」
  // と誤って解釈し、直後に押すとクールダウン拒否になる不整合が生じるため。
  // 両分岐とも ran: true（＝実際に runIngest() を実行した）で統一する。
  try {
    const summary = await runIngest();
    return {
      ok: true,
      ran: true,
      busy: false,
      ...summary,
      errors: sanitizeIngestErrors(summary.errors),
      cooldownUntil: claim.cooldownUntil,
    };
  } catch (err) {
    // サーバーログには生の例外を残す（ホスト名等が混ざり得るため公開面には出さない）。
    console.error("[actions] triggerIngest failed:", err);
    // 実行権の枠（クールダウン）は claimIngestSlot() の時点で既に消費済みであり、
    // ここでは返却しない（= cooldownUntil を null にせず claim.cooldownUntil を返す）。
    // runIngest() が失敗した直後にユーザーがリトライを連打できてしまうと、外部 API
    // （RSS フィード・Gemini）への呼び出しが際限なく繰り返され、無認証で公開している
    // ボタンからの予算焼き付きを防げなくなるため。
    return {
      ok: false,
      ran: true,
      busy: false,
      fetched: 0,
      inserted: 0,
      curated: 0,
      skipped: 0,
      errors: [INGEST_ERROR_MESSAGE],
      cooldownUntil: claim.cooldownUntil,
    };
  } finally {
    // 5. 成功・失敗いずれの場合も lease を必ず解放する。
    await releaseIngestLease(now);
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
