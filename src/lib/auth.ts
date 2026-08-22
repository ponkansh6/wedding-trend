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

/**
 * Basic 認証の検証（管理操作の Server Action 用の多層防御）。**fail-closed**:
 * `ADMIN_BASIC_AUTH_USER` / `ADMIN_BASIC_AUTH_PASSWORD` が未設定の場合は
 * 無条件に拒否する（`false`）。`isBearerAuthorized` と同じ方針を踏襲する
 * （env 未設定なら拒否、`NODE_ENV` では認証ロジックを分岐させない）。
 *
 * `/admin/*` は `src/middleware.ts` が Basic 認証で保護しているが、Server
 * Action は URL さえ知っていれば UI・ミドルウェアを経由せず直接呼び出せるため、
 * `triggerIngest()` / `submitSnsUrl()` はそれ自身の実行時にもここで再検証する
 * （UI を隠すだけ・ミドルウェアだけでは防御にならないという既存の設計規律を、
 * 管理操作の Server Action にも適用したもの）。
 *
 * `src/middleware.ts` は Edge ランタイムで動くため Web Crypto (`crypto.subtle`)
 * によるタイミングセーフ比較で同じ Basic 認証を検証している。Server Action は
 * Node ランタイムで動くため、ここでは `node:crypto` の `timingSafeEqual` を使う。
 * ロジックが 2 箇所に分かれているのはランタイム制約（Edge / Node）によるもので、
 * 一本化できない。
 *
 * @param requestHeaders `authorization` ヘッダーを読み取れるオブジェクト。
 *   Server Action からは `next/headers` の `headers()`（Promise を await 済みの
 *   `ReadonlyHeaders`）を渡す想定。
 */
export function isBasicAuthorized(requestHeaders: { get(name: string): string | null }): boolean {
  const user = process.env.ADMIN_BASIC_AUTH_USER;
  const pass = process.env.ADMIN_BASIC_AUTH_PASSWORD;
  if (!user || !pass) {
    console.warn(
      "[auth] ADMIN_BASIC_AUTH_USER / ADMIN_BASIC_AUTH_PASSWORD が未設定のため、Basic 認証を要求する管理操作を拒否しました（fail-closed）。",
    );
    return false;
  }

  const auth = requestHeaders.get("authorization");
  if (!auth?.startsWith("Basic ")) return false;

  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf-8");
  const separatorIndex = decoded.indexOf(":");
  const username = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : decoded;
  const password = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : "";

  const userBuf = Buffer.from(user);
  const usernameBuf = Buffer.from(username);
  const passBuf = Buffer.from(pass);
  const passwordBuf = Buffer.from(password);

  const userMatch = userBuf.length === usernameBuf.length && timingSafeEqual(userBuf, usernameBuf);
  const passMatch = passBuf.length === passwordBuf.length && timingSafeEqual(passBuf, passwordBuf);
  return userMatch && passMatch;
}
