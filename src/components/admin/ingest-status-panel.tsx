import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Coins, Sparkles } from "lucide-react";
import { formatAbsoluteJa, formatRelativeJa } from "@/components/feed/relative-time";
import { IngestTrigger } from "@/components/admin/ingest-trigger";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/cn";
import type { LastRunSummary } from "@/lib/pipeline/ingest";

type IngestStatusPanelProps = {
  /** `getIngestStatus()` の戻り値。まだ一度も実行されていなければ null。 */
  summary: LastRunSummary | null;
  /** 次に実行可能になる時刻（ISO8601）。null なら現在実行可能。 */
  cooldownUntil: string | null;
};

type RunStatus = "never" | "incomplete" | "ok";

/**
 * 収集の状態と操作を1枚にまとめた、`/admin` の主役パネル。
 *
 * 過去に「収集ボタンを押した→実際は成功していたが画面上は何も変わらず
 * 見えた」という事故があったため、このパネルは「押す」と「何が起きたか
 * 分かる」を同じカードの中の同じ視線の流れに置く（見出し → 状態バッジ →
 * 件数 → 直近の実行時刻 → 操作ボタン、の縦一列）。
 *
 * `finishedAt === null`（前回のランが完了しなかった）は正常時と明確に
 * 区別する: 状態バッジを赤系（既存の --color-trend。フォームのエラー表示と
 * 同じ色をここでも「異常」として再利用する）にし、カード上部にアクセント
 * バーと注意文を出す。
 */
export function IngestStatusPanel({ summary, cooldownUntil }: IngestStatusPanelProps) {
  const status: RunStatus = !summary ? "never" : summary.finishedAt === null ? "incomplete" : "ok";

  return (
    <section
      aria-labelledby="ingest-status-heading"
      className={cn(
        "flex flex-col gap-5 rounded-2xl border bg-[var(--color-surface)] p-5 shadow-[var(--shadow-card)] sm:p-6",
        status === "incomplete"
          ? "border-[var(--color-trend)]/40 border-t-4 border-t-[var(--color-trend)]"
          : "border-[var(--color-border)]",
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2
            id="ingest-status-heading"
            className="font-display text-[17px] font-semibold text-[var(--color-foreground)]"
          >
            新着記事の収集
          </h2>
          <p className="max-w-prose text-[13px] leading-jp-body tracking-jp-body text-[var(--color-muted-foreground)]">
            登録しているブログをまとめて確認し、新しい記事があればAI要約を付けてフィードに追加します。
          </p>
        </div>
        <StatusPill status={status} />
      </header>

      {status === "incomplete" && summary && (
        <div className="flex items-start gap-2.5 rounded-xl border border-[var(--color-trend)]/30 bg-[var(--color-trend-tint-a)]/40 px-4 py-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--color-trend)]" aria-hidden />
          <p className="text-[13px] leading-jp-body tracking-jp-body text-[var(--color-foreground)]">
            前回の実行が完了していません（タイムアウトまたは異常終了の可能性があります）。開始:{" "}
            <TimeLabel iso={summary.startedAt} />
          </p>
        </div>
      )}

      {status === "never" ? (
        <p className="text-[13px] text-[var(--color-muted-foreground)]">
          まだ一度も実行されていません。
        </p>
      ) : (
        summary && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <StatTile
                icon={<Sparkles className="size-3.5" aria-hidden />}
                label="フィードに追加"
                value={summary.curated}
                unit="件"
              />
              <StatTile
                icon={<Coins className="size-3.5" aria-hidden />}
                label="Gemini呼び出し"
                value={summary.geminiCalls}
                unit="回"
                hint="課金が発生する回数"
              />
            </div>

            <dl className="flex flex-wrap gap-x-5 gap-y-1.5 text-[12px] text-[var(--color-muted-foreground)]">
              <div className="flex gap-1">
                <dt>確認した記事</dt>
                <dd className="text-[var(--color-foreground)]">{summary.fetched}件</dd>
              </div>
              <div className="flex gap-1">
                <dt>新規保存</dt>
                <dd className="text-[var(--color-foreground)]">{summary.inserted}件</dd>
              </div>
              {summary.errorCount > 0 && (
                <div className="flex gap-1 text-[var(--color-trend)]">
                  <dt>エラー</dt>
                  <dd>{summary.errorCount}件</dd>
                </div>
              )}
            </dl>

            <p className="text-[12px] text-[var(--color-muted-foreground)]">
              {summary.trigger === "cron" ? "自動実行" : "手動実行"}
              {" ・ "}
              開始 <TimeLabel iso={summary.startedAt} />
              {summary.finishedAt && (
                <>
                  {" "}
                  ・ 完了 <TimeLabel iso={summary.finishedAt} />
                </>
              )}
            </p>
          </div>
        )
      )}

      <Separator />

      <IngestTrigger cooldownUntil={cooldownUntil} />
    </section>
  );
}

function StatusPill({ status }: { status: RunStatus }) {
  if (status === "never") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-border)] px-3 py-1 text-[12px] font-medium text-[var(--color-muted-foreground)]">
        未実行
      </span>
    );
  }
  if (status === "incomplete") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--color-trend)] px-3 py-1 text-[12px] font-semibold text-[var(--color-on-trend)]">
        <AlertTriangle className="size-3.5" aria-hidden />
        未完了
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--color-classic)] px-3 py-1 text-[12px] font-semibold text-[var(--color-on-classic)]">
      <CheckCircle2 className="size-3.5" aria-hidden />
      正常
    </span>
  );
}

function StatTile({
  icon,
  label,
  value,
  unit,
  hint,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  unit: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-muted-foreground)]">
        {icon}
        {label}
      </div>
      <p className="font-display text-[26px] font-semibold leading-none text-[var(--color-foreground)]">
        {value}
        <span className="ml-1 text-[13px] font-sans font-normal text-[var(--color-muted-foreground)]">
          {unit}
        </span>
      </p>
      {hint && <p className="text-[10px] text-[var(--color-muted-foreground)]">{hint}</p>}
    </div>
  );
}

/**
 * ラン結果の時刻表示。相対表記（「3分前」）を主に見せ、正確な時刻は
 * title 属性（hover）で確認できる。公開面の `PublishedTime` と同じ書式
 * ヘルパーを使い、時刻表現の言語を統一する。
 *
 * ここはサーバーコンポーネント内で評価されるため（`/admin` は
 * `force-dynamic`）、クライアントの Date.now() とは無関係で
 * hydration mismatch は起きない。
 */
function TimeLabel({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={formatAbsoluteJa(iso)} className="text-[var(--color-foreground)]">
      {formatRelativeJa(iso)}
    </time>
  );
}
