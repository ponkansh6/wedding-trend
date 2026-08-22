import { NextResponse } from "next/server";
import { isBearerAuthorized } from "@/lib/auth";
import { runIngest } from "@/lib/pipeline/ingest";

export const maxDuration = 60;

/**
 * 認証 → パイプライン実行 → JSON 応答、という薄いラッパー。
 * 実処理は `@/lib/pipeline/ingest`（`runIngest`）に一本化されており、
 * ここに実装を重複させない。
 */
async function handleTrigger(request: Request): Promise<Response> {
  if (!isBearerAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const summary = await runIngest();
  return NextResponse.json(summary);
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
