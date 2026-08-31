import { writeConfigValue } from "./ingest";
/**
 * Purpose: Gate state & source policy database operations (sourcePolicy, hostGateState, discoveryCursor).
 * When called: Source policy checks, host gate gating, discovery cursors.
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import { sourcePolicy, hostGateState, config } from "./schema";
export type SourcePolicyRow = typeof sourcePolicy.$inferSelect;
export async function getSourcePolicy(host: string): Promise<SourcePolicyRow | null> {
  try {
    const rows = await db.select().from(sourcePolicy).where(eq(sourcePolicy.host, host)).limit(1);
    return rows[0] ?? null;
  } catch (err) {
    console.warn("[db] getSourcePolicy error:", err);
    return null;
  }
}

/**
 * ホストの robots / 規約ポリシー行を upsert する（M3 / K2）。
 * `tosUrl` / `tosHash` を必須（`string | null`）にしているのは、K2（規約変更検知）
 * の実装で `tos_hash` が「休眠カラムのまま残る」状態（plan 07 §5-M3 の禁止事項）
 * を構造的に避けるため。規約 URL/ハッシュが無いホストは呼び出し側が明示的に
 * `null` を渡す。
 */
export async function upsertSourcePolicy(row: {
  host: string;
  robotsHash: string;
  robotsBody: string;
  tosUrl: string | null;
  tosHash: string | null;
  checkedAt: string;
}): Promise<void> {
  try {
    await db
      .insert(sourcePolicy)
      .values({
        host: row.host,
        robotsHash: row.robotsHash,
        robotsBody: row.robotsBody,
        tosUrl: row.tosUrl,
        tosHash: row.tosHash,
        checkedAt: row.checkedAt,
      })
      .onConflictDoUpdate({
        target: sourcePolicy.host,
        set: {
          robotsHash: row.robotsHash,
          robotsBody: row.robotsBody,
          tosUrl: row.tosUrl,
          tosHash: row.tosHash,
          checkedAt: row.checkedAt,
        },
      });
  } catch (err) {
    console.warn("[db] upsertSourcePolicy error:", err);
  }
}

export async function getDiscoveryCursor(host: string): Promise<string | null> {
  const key = `discovery:cursor:${host}`;
  try {
    const rows = await db
      .select({ value: config.value })
      .from(config)
      .where(eq(config.key, key))
      .limit(1);
    return rows[0]?.value ?? null;
  } catch (err) {
    console.warn(`[db] getDiscoveryCursor query error for host=${host}:`, err);
    return null;
  }
}

export async function setDiscoveryCursor(host: string, cursorISO: string): Promise<void> {
  const key = `discovery:cursor:${host}`;
  await writeConfigValue(key, cursorISO, new Date().toISOString());
}

/** ホスト単位のアクセス規律（kill gate）状態。 */
export interface HostGateState {
  host: string;
  /** 最後に状態を変えた gate の識別子（K1/K3/K4/K5/K6…）。稼働中は null。 */
  gateId: string | null;
  /** null=稼働中 / "cooloff"=一時停止（untilAt まで）/ "stopped"=K1 由来の人手復帰待ち / "permanent"=恒久停止 */
  stateKind: string | null;
  /** cooloff の有効期限（ISO 8601）。permanent/stopped では null。 */
  untilAt: string | null;
  /** K4（記事 403）の連続ストライク数。 */
  k4Strikes: number;
  /** 直近の 429 発生時刻（ISO 8601）。K6 の 24h 判定に使う。 */
  last429At: string | null;
  /** B1 日次カウンタの UTC 日付キー（YYYY-MM-DD）。 */
  countDay: string;
  /** B1 日次カウンタの値。 */
  countValue: number;
}

/**
 * ホスト単位の kill gate 状態を取得する（行が無ければ `null`）。
 *
 * `config` KV が ISO 8601 カーソル専用であるため、gate 識別子やストライク数
 * といった非 ISO の状態値は `host_gate_state` テーブルに永続化する
 * （plan 06 §6 の「config KV はカーソルだけ」の純粋性を維持する）。
 */
export async function getHostGateState(host: string): Promise<HostGateState | null> {
  try {
    const rows = await db.select().from(hostGateState).where(eq(hostGateState.host, host)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      host: row.host,
      gateId: row.gateId,
      stateKind: row.stateKind,
      untilAt: row.untilAt,
      k4Strikes: row.k4Strikes,
      last429At: row.last429At,
      countDay: row.countDay,
      countValue: row.countValue,
    };
  } catch (err) {
    console.warn(`[db] getHostGateState query error for host=${host}:`, err);
    return null;
  }
}

/**
 * ホスト単位の kill gate 状態を行ごと upsert する（read-modify-write 前提）。
 *
 * 書き込み失敗時は例外を握りつぶす（fail-open）。kill gate は実レスポンスから
 * 決定的に再誘発されるため、永続化漏れは次回の同レスポンスで再適用され、
 * 収集ラン全体を落とすより被害が小さい。ただし B1 日次カウンタのみ
 * 再構成不能なため、失敗時は警告ログで検知可能にしておく。
 */
export async function saveHostGateState(state: HostGateState): Promise<void> {
  const updatedAt = new Date().toISOString();
  try {
    await db
      .insert(hostGateState)
      .values({ ...state, updatedAt })
      .onConflictDoUpdate({
        target: hostGateState.host,
        set: {
          gateId: state.gateId,
          stateKind: state.stateKind,
          untilAt: state.untilAt,
          k4Strikes: state.k4Strikes,
          last429At: state.last429At,
          countDay: state.countDay,
          countValue: state.countValue,
          updatedAt,
        },
      });
  } catch (err) {
    console.warn(`[db] saveHostGateState error for host=${state.host}:`, err);
  }
}

// ── plan 07: 無人運転のデータ層契約（副表方式）────────────────────
// posts への ALTER を全廃し、公開判断の副表 `post_publications`（M4/Q4）と
// 終端理由の真実の源 `post_removals`（§7/M4）に分離する
// （`scripts/apply-migrations-remote.mjs` が共有本番 DB に対して CREATE TABLE /
// CREATE INDEX 以外を許可しないため。`post_usefulness_criteria` と同じ理由・
// 同じパターン）。`posts.status` は読み取り側のフェイルセーフとして併用する
// （`markRetracted` / `markDropped` の JSDoc 参照）。

/**
 * `post_publications` への upsert。M4 のジョブが以下の 2 通りで呼ぶ:
 * - 新規公開時: `publishedAt` = 本システムが公開した時刻、`bodyHash` = 判定時点の
 *   正規化本文ハッシュ。
 * - 自己修復シード時（`listPublishedForRevalidation` が行の無い公開済み post を
 *   返した場合）: `publishedAt` には **`posts.createdAt`（本システムが取り込んだ
 *   時刻）を使うこと**。ここで現在時刻や元記事側の `publishedAt` を入れると、
 *   本来ずっと前に公開されていた post が「たった今公開された」ものとして
 *   Q4（日次公開上限・ホストシェア上限）のレート計算に混入し、偽のバーストを
 *   引き起こす（結線・実際のシード呼び出しは別レーンが行う）。
 *
 * 「最初の理由が勝つ」不可逆性を要求する `post_removals` とは異なり、こちらは
 * 再検証のたびに `bodyHash` を更新してよいテーブルのため `onConflictDoUpdate`
 * を使う。
 */
/**
 * TTL 付き再試行キューへの投入（upsert）。一時的技術障害
 * （fetch_transient / llm_transient / rate_capped）のみを対象とする
 * （§7・§10: 抽出不足・接地失敗・判定不一致の再試行は明示的に禁止）。
 */
