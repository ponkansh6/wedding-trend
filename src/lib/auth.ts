import { timingSafeEqual } from "node:crypto";

/**
 * Bearer トークン認証。CRON_SECRET（等）が未設定ならローカル開発用に無認証で許可する
 * （本番運用では必ず設定する想定。check-env.ts が任意項目として警告する）。
 * タイミング攻撃を避けるため timingSafeEqual で比較する。
 */
export function isBearerAuthorized(request: Request, envVarName = "CRON_SECRET"): boolean {
  const secret = process.env[envVarName];
  if (!secret) return true;

  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;

  const token = auth.slice(7);
  const secretBuf = Buffer.from(secret);
  const tokenBuf = Buffer.from(token);
  if (secretBuf.length !== tokenBuf.length) return false;
  return timingSafeEqual(secretBuf, tokenBuf);
}
