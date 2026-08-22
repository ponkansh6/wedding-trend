import { NextResponse } from "next/server";
import { isBearerAuthorized } from "@/lib/auth";
import { recordCronIngestAt } from "@/lib/db/repository";
import { acquireIngestLease, releaseIngestLease } from "@/lib/pipeline/cooldown";
import { runIngest } from "@/lib/pipeline/ingest";

export const maxDuration = 60;

/**
 * 認証 → lease 取得 → パイプライン実行 → JSON 応答、という薄いラッパー。
 * 実処理は `@/lib/pipeline/ingest`（`runIngest`）に一本化されており、
 * ここに実装を重複させない。
 *
 * この経路（Bearer 認証済み・Vercel Cron）は `ingest_cooldown_until`
 * （`src/lib/pipeline/cooldown.ts` の `claimIngestSlot` / `getCooldownUntil`
 * が扱うクールダウン）に一切触れない。以前はここが「起点時刻の無条件上書き」
 * （旧 `markIngestStart()`）でクールダウンの基準時刻を更新していたが、収集
 * ボタンがオーナー限定（`/admin` の Basic 認証配下）に閉じられたことで、
 * cooldown と cron 実行の間に本来因果関係はない（cooldown は「認証済みの
 * 手動実行を短時間に連打しない」ためのものであり、1 日 1 回しか動かない
 * Cron の実行有無とは無関係）と整理し、cron はクールダウンの評価・更新の
 * どちらからも完全に外した。代わりに、Cron が最後にいつ動いたかを観測する
 * ためだけの別キー `last_cron_ingest_at` を無条件で記録する（`config` の
 * 他のキーとは独立しており、何の判定にも使われない）。
 *
 * ただし **lease（排他ロック）はこの経路も必ず取得する**。cooldown を
 * 評価しないからといって同時実行まで許してしまうと、Cron 実行中に手動
 * トリガーが押された場合に `runIngest()` が二重に走ってしまう（Gemini
 * 課金二重・重複挿入レース）。`acquireIngestLease()` に失敗した場合
 * （＝別の経路が実行中）は `runIngest()` を呼ばずに 409 を返す。
 *
 * `runIngest("cron")` の `trigger` 引数は `last_run_summary` テレメトリに
 * 記録される値であり、パイプラインの挙動そのものを変えない。
 */
async function handleTrigger(request: Request): Promise<Response> {
  if (!isBearerAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const leaseAcquired = await acquireIngestLease(now);
  if (!leaseAcquired) {
    return NextResponse.json({ error: "ingest already running" }, { status: 409 });
  }

  // 観測用の記録。cooldown（ingest_cooldown_until）とは独立したキーであり、
  // 書き込みに失敗してもレスポンスを止めない（テレメトリで本処理を壊さない）。
  try {
    await recordCronIngestAt(now.toISOString());
  } catch (err) {
    console.warn("[api/ingest] recordCronIngestAt failed (telemetry only, continuing):", err);
  }

  try {
    const summary = await runIngest("cron");
    return NextResponse.json(summary);
  } finally {
    await releaseIngestLease(now);
  }
}

/** curl 等からの手動トリガー。 */
export async function POST(request: Request) {
  return handleTrigger(request);
}

/**
 * Vercel Cron からの定期トリガー。Vercel Cron は GET でエンドポイントを叩き、
 * `CRON_SECRET` 環境変数が設定されていれば `Authorization: Bearer <CRON_SECRET>`
 * ヘッダーを自動付与する（`isBearerAuthorized` がそれを検証する）。
 * POST と同じ認証・同じパイプラインを実行し、単なる健康確認スタブにはしない。
 */
export async function GET(request: Request) {
  return handleTrigger(request);
}
