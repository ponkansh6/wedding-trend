import {
  claimIngestLease,
  claimLastIngestAt,
  getLastIngestAt,
  releaseIngestLease as releaseIngestLeaseRow,
  setLastIngestAt,
} from "@/lib/db/repository";

/**
 * 収集トリガー（`triggerIngest` Server Action / `/api/ingest`）の
 * グローバルクールダウン幅。
 *
 * 収集ボタンは無認証で本番の公開トップページに置かれるため、UI 側の
 * 表示制御だけでは連打・多重タブ・スクリプトからの直接呼び出しを防げない。
 * ここで定義する 4 時間はサーバー側（DB）で強制する最終防衛線であり、
 * Gemini API 予算の焼き付きを防ぐことが目的。
 *
 * **cooldown は排他制御ではない**。「公開ボタン経路だけ」に課すレートリミット
 * であり、Cron 経路はこの評価を免除される（詳細は `INGEST_LEASE_TTL_MS` の
 * JSDoc、および `acquireIngestLease` / `getCooldownUntil` を参照）。
 */
export const INGEST_COOLDOWN_MS = 4 * 60 * 60 * 1000;

/**
 * 収集パイプラインの実行排他（同時実行禁止）ロックの TTL。
 *
 * `INGEST_COOLDOWN_MS`（レートリミット）とは別概念。lease は「今まさに
 * `runIngest()` を実行しているのは高々 1 経路だけ」を保証する排他ロックで
 * あり、公開ボタン・Cron の**両経路が必ず取得する**（cooldown は公開ボタン
 * 経路だけが評価する）。これを分離した理由は、以前は cooldown 用の
 * `last_ingest_at` 一本で排他とレートリミットを兼ねていたため、cooldown を
 * 迂回する Cron 経路が排他からも同時に外れてしまい、Cron 実行中に公開ボタンが
 * 押されると `runIngest()` が二重に走っていた（Gemini 課金二重・重複挿入
 * レース）ため。
 *
 * TTL は 10 分。`runIngest()` の実測実行時間は長くても 60 秒程度だが、
 * タイムアウトやクラッシュでリースが解放されないまま残った場合に、次回の
 * 呼び出しが自動的に回復できるよう十分な余裕を持たせている。
 */
export const INGEST_LEASE_TTL_MS = 10 * 60 * 1000;

/** `now` から `INGEST_COOLDOWN_MS` 遡った時刻の ISO8601 文字列（カットオフ）。 */
function cutoffISO(now: Date): string {
  return new Date(now.getTime() - INGEST_COOLDOWN_MS).toISOString();
}

/**
 * `claimIngestSlot()` の戻り値。
 *
 * 以前は `{ claimed: true; cooldownUntil } | { claimed: false; cooldownUntil }`
 * という判別共用体だったが、両バリアントのフィールド構成が完全に同一
 * （`claimed` の値によらず `cooldownUntil` が必ず入る）で判別共用体である
 * 意味がなかったため、単純なオブジェクト型に統一した。
 */
export interface ClaimResult {
  claimed: boolean;
  cooldownUntil: string;
}

/**
 * 収集パイプラインの「実行権（クールダウンの枠）」を原子的に奪取する。
 * **公開ボタン経路（`triggerIngest`）専用**。呼び出し前提として、呼び出し元は
 * 既に `acquireIngestLease()` でリース（排他ロック）を取得済みであること
 * （このため実質的に呼び出しは直列化されており、下記の原子的 CAS は多重防御
 * として働く）。
 *
 * 4 時間以上経過していれば（または初回であれば）`last_ingest_at` を `now`
 * （＝実行開始時刻）に更新して `{ claimed: true, cooldownUntil }` を返す。
 * 経過していなければ、DB を書き換えずに `{ claimed: false, cooldownUntil }`
 * を返す。
 *
 * `claimed` の値によらず `cooldownUntil` は必ず入る。奪取に成功した場合の
 * `cooldownUntil` は「今回の実行によって新たに開始した」枠の満了時刻
 * （`now + INGEST_COOLDOWN_MS`）であり、奪取した瞬間に呼び出し元は
 * クールダウンの当事者になる（枠を消費した以上、その後 `runIngest()` が
 * 成功しようが失敗しようが次に実行可能になる時刻は変わらない）。
 * 呼び出し側（`triggerIngest()`）はこれを利用して、成功時・失敗時いずれの
 * 応答にも実際のクールダウン終了時刻を含める。
 *
 * 原子性の担保は `src/lib/db/repository.ts` の `claimLastIngestAt`
 * （単一の条件付き INSERT ... ON CONFLICT DO UPDATE ... WHERE 文）が行う。
 * 奪取に失敗した場合の `cooldownUntil` の算出は `getCooldownUntil()` に
 * 一本化しており、ここで計算式を重複実装しない。
 *
 * @param now テスト用に現在時刻を注入できる（省略時は `new Date()`）。
 */
export async function claimIngestSlot(now: Date = new Date()): Promise<ClaimResult> {
  const nowISO = now.toISOString();
  const claimed = await claimLastIngestAt(nowISO, cutoffISO(now));
  if (claimed) {
    return {
      claimed: true,
      cooldownUntil: new Date(now.getTime() + INGEST_COOLDOWN_MS).toISOString(),
    };
  }

  // 奪取に失敗した＝クールダウン中。表示用の「次に実行可能になる時刻」は
  // getCooldownUntil() に委譲する（claimLastIngestAt が false を返すのは
  // 行が既に存在し、かつクールダウン中の場合に限られるため、通常は非 null
  // が返る）。万一 null であれば安全側に倒し、今からクールダウンが必要と
  // みなす。
  const cooldownUntil = await getCooldownUntil(now);
  return {
    claimed: false,
    cooldownUntil: cooldownUntil ?? new Date(now.getTime() + INGEST_COOLDOWN_MS).toISOString(),
  };
}

/**
 * 公開ページの初期描画用。実行はせず、現在のクールダウン状態のみを返す
 * （DB を変更しない読み取り専用）。**クールダウン中でなければ null。**
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
  const lastIngestAt = await getLastIngestAt();
  if (!lastIngestAt) return null;
  const cooldownUntilMs = new Date(lastIngestAt).getTime() + INGEST_COOLDOWN_MS;
  if (cooldownUntilMs <= now.getTime()) return null;
  return new Date(cooldownUntilMs).toISOString();
}

/**
 * `last_ingest_at` を条件なしで `now`（＝実行開始時刻）に更新する。
 * **Cron 経路（`/api/ingest`）専用**。Bearer 認証済みリクエストはクールダウンの
 * *評価*を迂回して `runIngest()` を実行するが、`runIngest()` を呼ぶ**前**に
 * この関数で記録を更新する。
 *
 * 起点を「実行開始時刻」に統一している点に注意: 以前は公開ボタン経路が
 * 「奪取（＝実行開始）時刻」を起点にする一方、Cron 経路は `runIngest()` の
 * **完了後**に記録しており、両経路で起点が食い違っていた（Cron 実行に長時間
 * かかった場合、実際のクールダウン終了時刻が想定よりずれるバグ）。これを
 * `markIngestStart()` という名前に変更し、両経路とも実行開始時点で呼ぶことで
 * 統一している。
 *
 * 直後に公開ボタンが押されても不必要な二重実行にならないよう、実行前に
 * この関数で記録を更新しておく効果もある。
 *
 * @param now テスト用に現在時刻を注入できる（省略時は `new Date()`）。
 */
export async function markIngestStart(now: Date = new Date()): Promise<void> {
  await setLastIngestAt(now.toISOString());
}

/**
 * 収集パイプラインの実行排他ロック（lease）を原子的に取得する。
 * **全経路（公開ボタン・Cron）が必ず最初に呼ぶ**。
 *
 * 取得に成功したら true（呼び出し元は `runIngest()` を実行してよい）。
 * 取得に失敗したら false（＝別の経路が既に実行中）で、呼び出し元は
 * `runIngest()` を呼ばずに「実行中」を表す結果を返すこと。
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
