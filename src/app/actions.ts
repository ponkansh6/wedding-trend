"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { isBasicAuthorized } from "@/lib/auth";
import { detectEmbedProvider } from "@/lib/embed/providers";
import {
  acquireIngestLease,
  claimIngestSlot,
  extendIngestCooldownAfterRun,
  getCooldownUntil,
  releaseIngestLease,
} from "@/lib/pipeline/cooldown";
import { getLastRunSummary, runIngest, type LastRunSummary } from "@/lib/pipeline/ingest";
import { runSubmitUrlViaPipeline } from "@/lib/pipeline/submit-via-pipeline";
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
   * `false` はクールダウン中で見送ったこと、または認証に失敗したことを意味する
   * （エラーではない）。`ok` とは独立したフィールドであり、これを分けているのは
   * 「実行したが失敗した」（`ran: true, ok: false`）と「実行しなかった」
   * （`ran: false, ok: false`）を呼び出し側が区別できるようにするため。
   * `cooldownUntil` は実行の有無にかかわらず値が入り得るため、
   * 「実行されなかった」の判定には `cooldownUntil` の真偽ではなく
   * 必ずこの `ran` を使うこと。
   */
  ran: boolean;
  /**
   * 別の収集処理（`/admin` の別タブ、または Cron 経路）が実行中で、
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
   * 失敗いずれも）は「今回消費した枠」の満了時刻（Gemini を実際に呼んでいれば
   * 4 時間後、呼んでいなければ 15 分後）、見送った場合（`ran: false`）は
   * 「既存の枠」の満了時刻。null になるのは、クールダウンの状態を確定できな
   * かった場合、または認証に失敗した場合のみ。
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
 * 管理操作（収集トリガー・URL 投入・ラン結果の閲覧）が未認証・認証失敗の場合に
 * 画面へそのまま表示する文言。生の認証エラーの内部情報（どちらの資格情報が
 * 一致しなかったか等）は一切含めない。
 */
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
 * `/admin`（Basic 認証配下）の収集ボタンの初期描画用。実行はせず、現在の
 * クールダウン状態のみを返す（クールダウン中でなければ `cooldownUntil: null`）。
 * 読み取り専用のためここでは認証を要求しない（`getCooldownUntil()` 自体が
 * フェイルソフトで、クールダウンの残り時間という非機密情報を返すのみ）。
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
 * `/admin` に直近の収集ラン結果（`last_run_summary`）を表示するための読み取り
 * 専用ラッパー。`triggerIngest()` / `submitSnsUrl()` と同じく Basic 認証を
 * 多層防御として再検証する（`/admin` 配下は `src/middleware.ts` が保護している
 * が、Server Action は URL さえ知っていれば直接呼び出せるため）。
 *
 * 未認証・認証失敗の場合は `null` を返す（「まだ実行されていない」場合の
 * 応答と区別しない。認証に失敗した相手に「実行履歴があるかどうか」という
 * 情報自体を与えないため）。
 */
export async function getIngestStatus(): Promise<LastRunSummary | null> {
  if (!isBasicAuthorized(await headers())) {
    return null;
  }
  return getLastRunSummary();
}

/**
 * 収集処理が例外を投げた場合に公開面へそのまま返す固定文言。
 *
 * Gemini SDK / libSQL / undici 等が投げる例外の `message` にはホスト名・URL・
 * リクエスト断片が混ざり得るため、公開面には絶対に生の例外メッセージを出さない。
 * 実際の例外は console.error でサーバーログにのみ出力する。
 */
const INGEST_ERROR_MESSAGE = "収集処理でエラーが発生しました。時間をおいてお試しください。";

/**
 * `runIngest()` が例外を投げた場合、実際に Gemini を呼んでいたかどうかは
 * `summary` が存在しないため判別できない。安全側に倒し「呼んだ可能性がある」
 * とみなして無条件でクールダウンを 4 時間へ延長する（予算保護を優先する判断。
 * 詳細は `resolveCooldownAfterRun` を参照）。`extendIngestCooldownAfterRun()`
 * は `geminiCalls > 0` かどうかだけを見るため、実際の呼び出し回数ではなく
 * 「延長を強制する」ことを表す正の値として `1` を渡す。
 */
const ASSUME_GEMINI_CALLED = 1;

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
 * Basic 認証の検証に失敗した場合に返す `IngestResult`。lease/cooldown には
 * 一切触れていない（＝実行権を消費していない）ため `cooldownUntil: null`、
 * `ran: false`。
 */
function ingestUnauthorizedResult(): IngestResult {
  return {
    ok: false,
    ran: false,
    busy: false,
    fetched: 0,
    inserted: 0,
    curated: 0,
    skipped: 0,
    errors: [ADMIN_DISABLED_MESSAGE],
    cooldownUntil: null,
  };
}

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
 * `claimIngestSlot()` が確保した 15 分のクールダウンを、ラン完了後に必要なら
 * 4 時間へ延長し（`extendIngestCooldownAfterRun`）、その後の実際の
 * `cooldownUntil` を読み直して返す。
 *
 * `extendIngestCooldownAfterRun()` 自体は戻り値を持たない（void）ため、
 * 延長後の値を UI へ正しく返すには読み直しが必要。読み直しに
 * `getCooldownUntil()`（読み取り専用・フェイルソフト）を使うことで、
 * 延長が CAS の不一致で失敗したケース（他の呼び出しが既に新しい cooldown を
 * 確保していた場合）でも、内部で計算式を重複実装せず常に DB 上の実際の値を
 * 返せる。
 *
 * `extendIngestCooldownAfterRun()` 自体が書き込み経路のため fail-closed
 * （例外を投げ得る）。ここで catch し、失敗しても `triggerIngest()` 全体を
 * 未処理例外で落とさない（延長できなかった場合は、`claimIngestSlot()` が
 * 確保した 15 分のクールダウンがそのまま有効な状態として扱われる）。
 */
async function resolveCooldownAfterRun(
  claimedCooldownUntil: string,
  geminiCalls: number,
  now: Date,
): Promise<string> {
  try {
    await extendIngestCooldownAfterRun(claimedCooldownUntil, geminiCalls, now);
  } catch (err) {
    console.error(
      "[actions] triggerIngest: extendIngestCooldownAfterRun failed (cooldown may remain at the base 15-minute window):",
      err,
    );
  }
  const current = await getCooldownUntil(now);
  return current ?? claimedCooldownUntil;
}

/**
 * RSS 巡回パイプラインを実行する Server Action。`/admin`（`src/middleware.ts`
 * の Basic 認証配下）の収集ボタンから呼ばれる、オーナー限定の操作。
 *
 * 収集ボタンは以前、無認証で本番の公開トップページに置かれていたが、
 * 「体験談 0 件なのに更新制限」という誤解を招く報告（実際は ISR の stale
 * ページが原因）をきっかけに、オーナー限定（`/admin`）へ移した。UI を隠す
 * だけでは防御にならないため、3 段の防御を組み合わせる:
 *
 * 1. **Basic 認証の再検証（多層防御）**: `/admin` は `src/middleware.ts` で
 *    保護されているが、Server Action は URL さえ知っていれば直接呼び出せる
 *    ため、`isBasicAuthorized()` でこの Server Action 自身も再検証する。
 *    失敗したら `runIngest()` は一切呼ばず、安全な固定文言を返す。
 * 2. **lease（排他ロック、全経路共通）**: `acquireIngestLease()` が失敗したら
 *    ＝別の経路（Cron を含む）が実行中ということなので、`runIngest()` を
 *    呼ばずに `busy: true` を返す。
 * 3. **cooldown（連打防止、claim → extend の 2 段階）**: lease を取得した後、
 *    `claimIngestSlot()` が 15 分のクールダウンを DB 側で原子的に確保する
 *    （同時多重実行・空振り連打の防止が目的）。クールダウン中であれば lease
 *    を解放し、`runIngest()` を呼ばずに待機状態を返す。実行後、実際に
 *    Gemini を呼んでいれば（`summary.geminiCalls > 0`）
 *    `extendIngestCooldownAfterRun()` が 4 時間へ延長する（Gemini 予算の
 *    保護が目的。詳細は `src/lib/pipeline/cooldown.ts` を参照）。
 *
 * 全段を突破した場合のみ `runIngest("manual")` を実行し、成功・失敗いずれの
 * 場合も `finally` で必ず lease を解放する（呼び忘れると次の実行が
 * `INGEST_LEASE_TTL_MS` の間ブロックされる）。
 *
 * lease/cooldown の取得自体が例外を投げた場合（§ `ingestUnavailableResult`）も、
 * この Server Action は決して未処理例外で落とさず `IngestResult` を返す。
 */
export async function triggerIngest(): Promise<IngestResult> {
  // 0. Basic 認証の多層防御。lease/cooldown を消費する前に検証する。
  if (!isBasicAuthorized(await headers())) {
    return ingestUnauthorizedResult();
  }

  const now = new Date();

  // 1. lease（排他ロック）取得。全経路（`/admin` の手動トリガー・Cron）が対象。
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

  // 2. cooldown（連打防止）判定。claimIngestSlot() は「クールダウン中でなければ
  // 15 分の枠を確保する」ところまでを原子的に行う。lease 同様、書き込み経路を
  // 通るため fail-closed（例外を投げ得る）。ここに到達した時点で lease は既に
  // 取得済みなので、例外時は解放してから返す（解放そのものが失敗しても、
  // この Server Action は未処理例外で落ちない）。
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
  // 15 分のクールダウンを確保済みで、実行権の枠を既に消費している。
  try {
    const summary = await runIngest("manual");
    // runIngest() が実際に Gemini を呼んでいれば（geminiCalls > 0）クールダウンを
    // 4 時間へ延長する。呼んでいなければ 15 分のまま（空振りはタダでやり直せる）。
    const cooldownUntil = await resolveCooldownAfterRun(
      claim.cooldownUntil,
      summary.geminiCalls,
      now,
    );
    const { fetched, inserted, curated, skipped, errors } = summary;
    return {
      ok: true,
      ran: true,
      busy: false,
      fetched,
      inserted,
      curated,
      skipped,
      errors: sanitizeIngestErrors(errors),
      cooldownUntil,
    };
  } catch (err) {
    // サーバーログには生の例外を残す（ホスト名等が混ざり得るため公開面には出さない）。
    console.error("[actions] triggerIngest failed:", err);
    // runIngest() が例外を投げた場合、実際に Gemini を呼んでいたかは summary が
    // 無いため判別できない。安全側（予算保護優先）に倒し、無条件で 4 時間へ
    // 延長する（ASSUME_GEMINI_CALLED の JSDoc を参照）。
    const cooldownUntil = await resolveCooldownAfterRun(
      claim.cooldownUntil,
      ASSUME_GEMINI_CALLED,
      now,
    );
    return {
      ok: false,
      ran: true,
      busy: false,
      fetched: 0,
      inserted: 0,
      curated: 0,
      skipped: 0,
      errors: [INGEST_ERROR_MESSAGE],
      cooldownUntil,
    };
  } finally {
    // 成功・失敗いずれの場合も lease を必ず解放する。
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
 * SNS 投稿 URL を 1 件取り込む。`/admin`（Basic 認証配下）の運用フォームから
 * 呼ばれる、オーナー限定の操作。`note` は運営が添える補足メモ（省略可）。
 * 空白のみの入力は「補足なし」として扱う。
 */
export async function submitSnsUrl(url: string, note?: string): Promise<SubmitUrlResult> {
  // /admin は src/middleware.ts の Basic 認証で保護されているが、Server Action
  // は URL さえ知っていれば UI・ミドルウェアを経由せず直接呼び出せるため、
  // 必ず自身の実行時にも再検証する（多層防御。src/lib/auth.ts の
  // isBasicAuthorized 参照）。
  if (!isBasicAuthorized(await headers())) {
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
    const outcome = await runSubmitUrlViaPipeline(parsed.data, noteArg);

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
