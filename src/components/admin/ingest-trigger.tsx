"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Clock, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { triggerIngest } from "@/app/actions";

/**
 * 取得は最大60秒ほどかかるため、経過に応じてメッセージを切り替え、
 * 「止まっているのではなく進んでいる」ことを伝える。実際の進捗は
 * サーバー側から取得できないため、平均的な所要時間から見た目上の
 * 目安として段階を進める（正確な進捗率ではない）。
 */
const PROGRESS_STEPS = [
  "登録しているブログの新着を確認しています…",
  "新しい記事を選んでいます…",
  "AIが要約を書いています…",
  "もう少しで完了します…",
] as const;

const STEP_INTERVAL_MS = 9_000;

/** クールダウンの残り表示・自動復帰チェックの更新間隔。秒単位の厳密さは不要。 */
const COOLDOWN_TICK_MS = 30_000;

/**
 * 「次に確認できるのは14:30ごろ」の時刻部分。固定のタイムゾーンで整形するため
 * サーバーの実行環境のタイムゾーンに関わらずサーバー・クライアントで
 * 同じ文字列になる（Date.now() を使わないので hydration mismatch も起きない）。
 */
const jstClockFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * ミリ秒の残り時間を「あと40分」「あと2時間」のような、クールダウンの幅
 * （15分〜4時間。詳細は `src/lib/pipeline/cooldown.ts`）に見合う粗い粒度の
 * 日本語に整形する。秒単位のカウントダウンは意図的に行わない。
 */
function formatRemaining(ms: number): string | null {
  if (ms <= 0) return null;
  const totalMinutes = Math.max(1, Math.round(ms / 60_000));
  if (totalMinutes < 60) {
    const rounded = Math.min(55, Math.max(5, Math.round(totalMinutes / 5) * 5));
    return `あと${rounded}分`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.round((totalMinutes % 60) / 10) * 10;
  if (minutes === 0) return `あと${hours}時間`;
  if (minutes === 60) return `あと${hours + 1}時間`;
  return `あと${hours}時間${minutes}分`;
}

type IngestTriggerProps = {
  className?: string;
  /** 空状態などの控えめな文脈で使う場合に true。ボタンを一段小さくする。 */
  compact?: boolean;
  /**
   * サーバー時点でのクールダウン終了時刻（ISO8601）。null なら実行可能。
   *
   * ここは絶対時刻の文字列のみをサーバー・クライアントの初期描画で共有し、
   * 「現在時刻との差」に依存する表示（残り分数の表示・期限切れ判定）は
   * マウント後の useEffect でのみ算出する。サーバーとクライアントで
   * Date.now() の値が異なりうるため、それを初期描画に混ぜると
   * hydration mismatch を起こす。
   */
  cooldownUntil: string | null;
};

/**
 * オーナーがフィードの新着を手動で呼び込むための操作（`/admin` 配下、
 * `src/middleware.ts` の Basic 認証で保護される）。サーバー側でクールダウンが
 * 強制される（実行開始時に15分を確保し、実際に Gemini を呼んだ場合のみ
 * 4時間へ延長される。詳細は `src/lib/pipeline/cooldown.ts`）ため、UI 側は
 * 「押せる／実行中／クールダウン中」の3状態を、押す前から結果が
 * 予測できる形で表現する。
 */
export function IngestTrigger({ className, compact = false, cooldownUntil }: IngestTriggerProps) {
  const [isPending, startTransition] = useTransition();
  const [stepIndex, setStepIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [cooldown, setCooldown] = useState(cooldownUntil);
  // ページ全体の再検証（router.refresh）で新しい cooldownUntil が props として
  // 降ってきたら、このインスタンスの状態を追従させる。同じボタンが複数箇所に
  // 設置されているため、自分ではなく別の設置箇所から実行された場合でも
  // 反映されるようにする。「レンダー中に前回の props を覚えておき、変化して
  // いたら state を合わせて更新する」React 公式の adjusting-state パターンで、
  // Effect 内で setState するより 1 回分レンダーが少なく済む。
  const [prevCooldownProp, setPrevCooldownProp] = useState(cooldownUntil);
  if (cooldownUntil !== prevCooldownProp) {
    setPrevCooldownProp(cooldownUntil);
    setCooldown(cooldownUntil);
  }
  // マウント後にだけ埋まる「あと◯分」表示。初期値は常に null なので
  // サーバー描画・クライアント初回描画のどちらでも一致する。
  const [remainingLabel, setRemainingLabel] = useState<string | null>(null);
  const router = useRouter();
  const statusId = useId();

  useEffect(() => {
    // cooldown が null（実行可能）の間は表示側で参照されないため、
    // ここで明示的にリセットする必要はない。次にクールダウンへ入った際は
    // 下の tick() が即座に新しい値で上書きする。
    if (!cooldown) return;

    const target = new Date(cooldown).getTime();

    const tick = () => {
      const remaining = target - Date.now();
      if (remaining <= 0) {
        // クールダウン期限を過ぎたら、リロードなしで自動的に押せる状態へ戻す。
        setCooldown(null);
        setRemainingLabel(null);
        return;
      }
      setRemainingLabel(formatRemaining(remaining));
    };

    tick();
    const timer = setInterval(tick, COOLDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [cooldown]);

  useEffect(() => {
    if (!isPending) return;

    const stepTimer = setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, PROGRESS_STEPS.length - 1));
    }, STEP_INTERVAL_MS);
    const clock = setInterval(() => setElapsed((s) => s + 1), 1000);

    return () => {
      clearInterval(stepTimer);
      clearInterval(clock);
    };
  }, [isPending]);

  const isCoolingDown = cooldown !== null;
  const isDisabled = isPending || isCoolingDown;

  const handleClick = () => {
    if (isDisabled) return;
    setStepIndex(0);
    setElapsed(0);
    startTransition(async () => {
      const result = await triggerIngest();

      if (result.busy) {
        // 定期実行（cron）や他の訪問者の操作が「今まさに走っている」ケース。
        // クールダウンによる見送りとは原因が違うので、待てば押せることが
        // 伝わる文言にする。この場合クールダウンには入っていないため、
        // ボタンは押せる状態のまま残す。
        toast.info("いま更新中です。少し待ってからお試しください。");
        return;
      }

      if (!result.ran) {
        // 直前に実行済みで、クールダウン中のため見送られたケース
        // （15分〜4時間。詳細は src/lib/pipeline/cooldown.ts）。
        // cooldownUntil は「見送り／成功／失敗」の3分岐すべてで非 null が返るため、
        // 「実行されなかった」の判別には使えない。必ず ran を見ること。
        setCooldown(result.cooldownUntil);
        toast.info("ひと足違いで、ちょうど更新されたところでした。時間をおいてお試しください。");
        return;
      }

      if (result.ok) {
        toast.success(
          result.inserted > 0
            ? `新しい記事を${result.inserted}件追加しました`
            : "新しい記事はありませんでした",
          {
            description:
              result.errors.length > 0
                ? `一部のブログを確認できませんでした: ${result.errors.join(" / ")}`
                : `${result.fetched}件を確認し、${result.curated}件にAI要約を付けました。`,
          },
        );
      } else {
        toast.error("新着の確認に失敗しました", {
          description:
            result.errors.length > 0 ? result.errors.join(" / ") : "原因を特定できませんでした。",
        });
      }

      // 実行した場合、result.cooldownUntil は今回消費した枠の満了時刻。
      // 成功・失敗どちらでも枠は消費済みなので、そのまま反映する。
      setCooldown(result.cooldownUntil);
      router.refresh();
    });
  };

  let statusText = "押すと、登録しているブログに新しい記事がないか確認します。";
  if (isPending) {
    statusText = `${PROGRESS_STEPS[stepIndex]}（${elapsed}秒経過・最大1分ほどかかります）`;
  } else if (isCoolingDown && cooldown) {
    const jstLabel = jstClockFormatter.format(new Date(cooldown));
    statusText = `さきほど更新したばかりです。次に更新できるのは${jstLabel}ごろです。${
      remainingLabel ? `（${remainingLabel}）` : ""
    }`;
  }

  let icon = <RefreshCw className="size-4" aria-hidden />;
  if (isPending) {
    icon = <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />;
  } else if (isCoolingDown) {
    icon = <Clock className="size-4" aria-hidden />;
  }

  return (
    <div className={cn("flex flex-col items-start gap-2 text-left", className)}>
      <Button
        type="button"
        variant="trend"
        size={compact ? "sm" : "default"}
        onClick={handleClick}
        aria-disabled={isDisabled}
        aria-busy={isPending}
        aria-describedby={statusId}
        className={cn("w-fit", isDisabled && "pointer-events-none opacity-50")}
      >
        {icon}
        {isPending ? "更新しています…" : "フィードを更新する"}
      </Button>
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className={cn(
          "text-[12px] leading-jp-body tracking-jp-body text-[var(--color-muted-foreground)]",
          !isPending && !isCoolingDown && "sr-only",
        )}
      >
        {statusText}
      </p>
    </div>
  );
}
