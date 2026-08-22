import {
  INGEST_BASE_COOLDOWN_MS,
  INGEST_FULL_COOLDOWN_MS,
  INGEST_LEASE_TTL_MS,
} from "@/lib/constants";
import {
  claimIngestCooldown,
  claimIngestLease,
  extendIngestCooldown,
  getIngestCooldownValue,
  releaseIngestLease as releaseIngestLeaseRow,
} from "@/lib/db/repository";

/**
 * 収集トリガー（`triggerIngest` Server Action / `/api/ingest`）の
 * クールダウン機構。
 *
 * 収集ボタンはオーナー限定（`/admin` の Basic 認証配下）に閉じるため、以前の
 * ような「無認証の公開ボタンからの濫用を fail-closed で防ぐ」という前提は
 * もう成立しない。そのため設計を「先行して 4 時間を確保し、失敗したら
 * 巻き戻す」方式から、**claim（確保）と extend（延長）の 2 段階**に変更した:
 *
 * 1. **claim**: 実行開始時に `INGEST_BASE_COOLDOWN_MS`（15 分）だけ確保する。
 *    これは「同時多重実行の防止」と「空振り実行の連打防止」が目的で、
 *    Gemini 予算の保護が目的ではない。
 * 2. **extend**: ラン完了後、`runIngest()` が実際に Gemini を呼んでいれば
 *    （`geminiCalls > 0`）`INGEST_FULL_COOLDOWN_MS`（4 時間）へ延長する。
 *    Gemini を一切呼んでいなければ（＝新着ゼロ等の空振り）延長しない。
 *    空振りには課金コストが掛かっていないため、長時間ブロックする理由が
 *    ないという判断（詳細は `extendIngestCooldownAfterRun` を参照）。
 *
 * `config.ingest_cooldown_until` は「クールダウンの起点時刻」ではなく
 * **期限そのもの**（絶対時刻の ISO8601 文字列）を保持する。読み取り
 * （`getCooldownUntil`）は保存値と `now` を比較するだけで、算術（時刻の加算）
 * を一切行わない。
 */
export interface ClaimResult {
  claimed: boolean;
  cooldownUntil: string;
}

/**
 * 収集パイプラインの「実行権（クールダウンの枠）」を原子的に奪取する。
 *
 * `INGEST_BASE_COOLDOWN_MS`（15 分）が経過していれば（または初回であれば）
 * `ingest_cooldown_until` を `now + INGEST_BASE_COOLDOWN_MS` に更新して
 * `{ claimed: true, cooldownUntil }` を返す。経過していなければ、DB を
 * 書き換えずに `{ claimed: false, cooldownUntil }` を返す。
 *
 * `claimed` の値によらず `cooldownUntil` は必ず入る。奪取に成功した場合の
 * `cooldownUntil` は「今回の確保によって新たに立てた」期限（15 分後）であり、
 * この時点ではまだ 4 時間への延長は行われていない。Gemini を実際に呼んだ
 * ランであれば、呼び出し元がラン完了後に `extendIngestCooldownAfterRun()`
 * をこの `cooldownUntil` を渡して呼ぶことで 4 時間へ延長する契約になっている
 * （この関数自身は延長を行わない）。
 *
 * 原子性の担保は `src/lib/db/repository.ts` の `claimIngestCooldown`
 * （単一の条件付き INSERT ... ON CONFLICT DO UPDATE ... WHERE 文）が行う。
 * 奪取に失敗した場合の `cooldownUntil` の算出は `getCooldownUntil()` に
 * 一本化しており、ここで計算式を重複実装しない。
 *
 * @param now テスト用に現在時刻を注入できる（省略時は `new Date()`）。
 */
export async function claimIngestSlot(now: Date = new Date()): Promise<ClaimResult> {
  const nowISO = now.toISOString();
  const deadlineISO = new Date(now.getTime() + INGEST_BASE_COOLDOWN_MS).toISOString();
  const claimed = await claimIngestCooldown(nowISO, deadlineISO);
  if (claimed) {
    return { claimed: true, cooldownUntil: deadlineISO };
  }

  // 奪取に失敗した＝クールダウン中。表示用の「次に実行可能になる時刻」は
  // getCooldownUntil() に委譲する（claimIngestCooldown が false を返すのは
  // 行が既に存在し、かつクールダウン中の場合に限られるため、通常は非 null
  // が返る）。万一 null であれば安全側に倒し、今からクールダウンが必要と
  // みなす。
  const cooldownUntil = await getCooldownUntil(now);
  return { claimed: false, cooldownUntil: cooldownUntil ?? deadlineISO };
}

/**
 * 公開面の初期描画用。実行はせず、現在のクールダウン状態のみを返す
 * （DB を変更しない読み取り専用）。**クールダウン中でなければ null。**
 *
 * `config.ingest_cooldown_until` には期限そのものが保存されているため、
 * ここでの判定は算術なしの単純な比較（`value > now ? value : null`）のみ。
 *
 * `claimIngestSlot()` の戻り値とは意味が異なる点に注意: こちらは
 * 「今このボタンを押せるか」を表す判定結果であり、押せるなら null
 * （＝クールダウン情報が存在しない）を返す。一方 `claimIngestSlot()` は
 * 実行権を奪取する（＝枠を消費する）操作であり、奪取に成功した場合も
 * その時点で新たなクールダウンが始まるため、成功時も含めて必ず
 * `cooldownUntil` を返す。「押せるかどうかの事前確認」と「押した結果」
 * では null の意味が異なるので、この関数の戻り値をそのまま
 * `IngestResult.cooldownUntil` に流用しないこと。
 *
 * @param now テスト用に現在時刻を注入できる（省略時は `new Date()`）。
 */
export async function getCooldownUntil(now: Date = new Date()): Promise<string | null> {
  const value = await getIngestCooldownValue();
  if (!value) return null;
  return value > now.toISOString() ? value : null;
}

/**
 * ラン完了後、実際に Gemini を呼んでいた場合のみクールダウンを
 * `INGEST_FULL_COOLDOWN_MS`（4 時間）へ延長する。
 *
 * 述語はこれだけ: **`geminiCalls > 0` なら延長する。`geminiCalls === 0` なら
 * 何もしない**（`claimIngestSlot()` が確保した 15 分のまま）。空振り
 * （Gemini を呼ばなかった実行）はコストが掛かっていないため、タダで
 * やり直せる方が望ましいという判断。`runIngest()` の `errors` 文字列の中身を
 * 見て分類するような手段は使わない（腐りやすいため）。
 *
 * 延長は `src/lib/db/repository.ts` の `extendIngestCooldown` による
 * **CAS（Compare-And-Swap）**で行う: `claimedCooldownUntil`（`claimIngestSlot()`
 * が返した値）と保存済みの値が完全一致するときのみ書き換える。これにより、
 * 自分の claim 後に他の呼び出しが新たに cooldown を確保していた場合、その
 * 新しい期限を無条件延長で静かに上書きしてしまう事故を防ぐ。また CAS の
 * 条件には「新しい値の方が新しい（＝単調増加）」も含まれるため、既に 4 時間
 * 先の期限が立っている状態でこの関数が再度呼ばれても、期限が短縮方向に
 * 書き換わることはない。
 *
 * @param claimedCooldownUntil `claimIngestSlot()` が返した `cooldownUntil`
 *   （＝自分が確保した期限）。
 * @param geminiCalls `runIngest()` が実際に呼んだ Gemini API の回数。
 * @param now テスト用に現在時刻を注入できる（省略時は `new Date()`）。
 */
export async function extendIngestCooldownAfterRun(
  claimedCooldownUntil: string,
  geminiCalls: number,
  now: Date = new Date(),
): Promise<void> {
  if (geminiCalls <= 0) return;
  const newDeadlineISO = new Date(now.getTime() + INGEST_FULL_COOLDOWN_MS).toISOString();
  await extendIngestCooldown(now.toISOString(), claimedCooldownUntil, newDeadlineISO);
}

/**
 * 収集パイプラインの実行排他ロック（lease）を原子的に取得する。
 * **全経路（公開ボタン・Cron）が必ず最初に呼ぶ**。
 *
 * 取得に成功したら true（呼び出し元は `runIngest()` を実行してよい）。
 * 取得に失敗したら false（＝別の経路が既に実行中）で、呼び出し元は
 * `runIngest()` を呼ばずに「実行中」を表す結果を返すこと。
 *
 * cooldown（レートリミット・空振り連打防止）とは別概念。lease は「今まさに
 * `runIngest()` を実行しているのは高々 1 経路だけ」を保証する排他ロックで
 * あり、公開ボタン・Cron の**両経路が必ず取得する**。
 *
 * 原子性の担保は `src/lib/db/repository.ts` の `claimIngestLease`
 * （単一の条件付き INSERT ... ON CONFLICT DO UPDATE ... WHERE 文）が行う。
 * 取得に成功した経路は、実行完了時（成功・失敗いずれも）に必ず `finally` で
 * `releaseIngestLease()` を呼んでリースを解放すること。
 *
 * @param now テスト用に現在時刻を注入できる（省略時は `new Date()`）。
 */
export async function acquireIngestLease(now: Date = new Date()): Promise<boolean> {
  const leaseUntilISO = new Date(now.getTime() + INGEST_LEASE_TTL_MS).toISOString();
  return claimIngestLease(now.toISOString(), leaseUntilISO);
}

/**
 * `acquireIngestLease()` で取得したリースを解放する。
 * リース値を過去日時で無条件上書きすることで、次の呼び出しが即座に
 * `acquireIngestLease()` に成功できるようにする。
 *
 * `runIngest()` を呼んだ経路は、成功・失敗いずれの場合も `finally` で
 * 必ずこれを呼ぶこと（呼び忘れると次の実行が `INGEST_LEASE_TTL_MS` の間
 * ブロックされ続ける）。
 *
 * @param now テスト用に現在時刻を注入できる（省略時は `new Date()`）。
 */
export async function releaseIngestLease(now: Date = new Date()): Promise<void> {
  await releaseIngestLeaseRow(now.toISOString());
}
