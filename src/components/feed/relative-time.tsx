/**
 * 公開日時を日本語の相対表記に変換する。
 *
 * FeedCard はサーバーコンポーネントのままにし、ここでの計算をリクエスト時に
 * サーバー側で完結させることで、クライアントでの再計算によるハイドレーション
 * ミスマッチを避けている（クライアントコンポーネント化・useEffect は不要）。
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

export function formatRelativeJa(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diff = now.getTime() - then;

  if (!Number.isFinite(diff)) return "";
  if (diff < MINUTE) return "たった今";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}分前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}時間前`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}日前`;
  if (diff < MONTH) return `${Math.floor(diff / (7 * DAY))}週間前`;
  if (diff < YEAR) return `${Math.floor(diff / MONTH)}ヶ月前`;
  return `${Math.floor(diff / YEAR)}年前`;
}

export function formatAbsoluteJa(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(d);
}

/** publishedAt が null の場合を含めて安全にレンダリングする <time> */
export function PublishedTime({ iso }: { iso: string | null }) {
  if (!iso) {
    return <span className="text-[var(--color-muted-foreground)]">投稿日時不明</span>;
  }
  return (
    <time dateTime={iso} title={formatAbsoluteJa(iso)}>
      {formatRelativeJa(iso)}
    </time>
  );
}
