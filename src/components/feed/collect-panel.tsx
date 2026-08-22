import { IngestTrigger } from "@/components/feed/ingest-trigger";

type CollectPanelProps = {
  /** サーバー時点でのクールダウン終了時刻（ISO8601）。null なら実行可能。 */
  cooldownUntil: string | null;
};

/**
 * 訪問者が自分でフィードの新着を呼び込むための、公開・無認証の操作の
 * 主導線。管理者専用の運用パネルとは切り離し、フィードの直前・
 * ページ最上部に置くことで「これは触ってよい機能」だと最初に伝える。
 * 見た目はフィードカードと同じ材質（surface + shadow-card）にして、
 * デバッグ用の操作パネルではなくサイトの常設機能であることを示す。
 */
export function CollectPanel({ cooldownUntil }: CollectPanelProps) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 shadow-[var(--shadow-card)] sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="flex flex-col gap-1">
        <p className="font-display text-[15px] font-semibold text-[var(--color-foreground)]">
          新着記事を確認する
        </p>
        <p className="text-[13px] leading-jp-body tracking-jp-body text-[var(--color-muted-foreground)]">
          登録している卒花ブログをまとめて確認します。新しい記事があれば、AI要約を添えてフィードに追加します。30秒〜1分ほどかかります。
        </p>
      </div>
      <IngestTrigger cooldownUntil={cooldownUntil} className="sm:shrink-0" />
    </div>
  );
}
