import { timingSafeEqual } from "node:crypto";

/**
 * Bearer トークン認証。**fail-closed**: 検証用の secret（環境変数）が
 * 未設定の場合は無条件に拒否する（`false`）。
 *
 * `NODE_ENV` / `VERCEL_ENV` 等の実行環境で分岐しないこと。環境によって
 * 認証ロジック自体が変わる設計（＝未設定時は「ローカル開発向けに」無認証で
 * 許可する fail-open 設計）が、本番デプロイで secret を設定し忘れた際に
 * `/api/ingest` や `/api/submit-url` を無認証公開してしまう事故の原因だった。
 * ローカル開発で通したい場合は `.env.local` に開発用の値を設定すること
 * （`.env.local.example` 参照。設定しない限りローカルでも 401 になる）。
 *
 * タイミング攻撃を避けるため timingSafeEqual で比較する。
 */
export function isBearerAuthorized(request: Request, envVarName = "CRON_SECRET"): boolean {
  const secret = process.env[envVarName];
  if (!secret) {
    // secret の値そのものはログに出さない。設定漏れに気づけるよう、
    // 拒否した事実と原因（どの環境変数が未設定か）のみを記録する。
    console.warn(
      `[auth] ${envVarName} が未設定のため、Bearer 認証を要求するリクエストを拒否しました（fail-closed）。`,
    );
    return false;
  }

  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;

  const token = auth.slice(7);
  const secretBuf = Buffer.from(secret);
  const tokenBuf = Buffer.from(token);
  if (secretBuf.length !== tokenBuf.length) return false;
  return timingSafeEqual(secretBuf, tokenBuf);
}
