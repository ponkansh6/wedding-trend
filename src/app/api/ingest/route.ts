import { NextResponse } from "next/server";
import { isBearerAuthorized } from "@/lib/auth";
import { acquireIngestLease, markIngestStart, releaseIngestLease } from "@/lib/pipeline/cooldown";
import { runIngest } from "@/lib/pipeline/ingest";

export const maxDuration = 60;

/**
 * 認証 → lease 取得 → パイプライン実行 → JSON 応答、という薄いラッパー。
 * 実処理は `@/lib/pipeline/ingest`（`runIngest`）に一本化されており、
 * ここに実装を重複させない。
 *
 * この経路（Bearer 認証済み・Vercel Cron）は公開 UI の収集ボタンにかかる
 * 4 時間のグローバルクールダウン（`src/lib/pipeline/cooldown.ts` の
 * `claimIngestSlot` が行う *cooldown* の評価）を意図的に迂回する。Cron は
 * 6 時間ごとにしか叩かれず認証済みであるため濫用防止の対象外である。
 *
 * ただし **lease（排他ロック）はこの経路も必ず取得する**。cooldown を迂回
 * できるからといって同時実行まで許してしまうと、Cron 実行中に公開ボタンが
 * 押された場合に `runIngest()` が二重に走ってしまう（Gemini 課金二重・
 * 重複挿入レース）。`acquireIngestLease()` に失敗した場合（＝別の経路が
 * 実行中）は `runIngest()` を呼ばずに 409 を返す。
 *
 * lease 取得後、`runIngest()` を呼ぶ**前**に `markIngestStart()` で
 * `last_ingest_at` を実行開始時刻で更新しておく。これにより、Cron 実行の
 * 直後に公開ボタンが押されても不必要に二重実行にならない
 * （公開ボタン経路のクールダウン起点と統一するため、更新するのは
 * 「完了時刻」ではなく「実行開始時刻」である点に注意）。
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

  try {
    await markIngestStart(now);
    const summary = await runIngest();
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
