import { RETRY_BACKOFF_HOURS, RETRY_MAX_ATTEMPTS, RETRY_TTL_HOURS } from "@/lib/constants";
import { addHoursIso } from "./retry-time";

export type DiscoveryRetryInput = {
  nowIso: string;
  attempts: number;
  firstQueuedAt: string | null;
};

export type DiscoveryRetryDecision =
  | { kind: "terminal" }
  | {
      kind: "schedule";
      attempts: number;
      firstQueuedAt: string;
      nextAttemptAt: string;
      expiresAt: string;
    };

function backoffHoursFor(attempts: number): number {
  const index = Math.min(attempts, RETRY_BACKOFF_HOURS.length - 1);
  return RETRY_BACKOFF_HOURS[index] ?? RETRY_BACKOFF_HOURS[RETRY_BACKOFF_HOURS.length - 1];
}

/**
 * discovery レーンの一時失敗を、再試行に積むか終端にするか決定する。
 * DB、URL、本文、理由コードは呼び出し元の副作用境界に残す。
 */
export function decideDiscoveryRetry(input: DiscoveryRetryInput): DiscoveryRetryDecision {
  const attempts = input.attempts;
  const nextAttempts = attempts + 1;
  const firstQueuedAt = input.firstQueuedAt ?? input.nowIso;

  if (nextAttempts > RETRY_MAX_ATTEMPTS) return { kind: "terminal" };

  return {
    kind: "schedule",
    attempts: nextAttempts,
    firstQueuedAt,
    nextAttemptAt: addHoursIso(input.nowIso, backoffHoursFor(attempts)),
    expiresAt: addHoursIso(firstQueuedAt, RETRY_TTL_HOURS),
  };
}
