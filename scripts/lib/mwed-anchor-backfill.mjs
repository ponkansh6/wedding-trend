/**
 * `scripts/backfill-mwed-anchors.mjs` の中核ロジックを、DB 接続・LLM 呼び出し・
 * ネットワーク I/O・`process.exit` を一切含まない純粋関数として切り出したもの。
 *
 * このスクリプトが救済する対象は discovery 経路（`posts.original_excerpt` が
 * 常に null。spec §10-5）で公開済みの投稿である。本文をメモリ上でだけ再取得し、
 * 判定スライスを復元して再キュレーションする。**判定スライスは §10-5 のとおり
 * DB へ書き戻してはならない**——この不変条件を単体テストで固定するのが本モジュール
 * を切り出す主目的である:
 *
 * 1. `buildMwedUpdates()` が返す各 update オブジェクトのキーは許可リスト
 *    （url / aiSummary / category / tag / contentHash / curationSignature /
 *     usefulness / rationale）のみで、判定スライス本文を運ぶフィールドは
 *    構造的に存在しない（candidate に slice を持たせない設計）。
 * 2. `kind === "llm_failed"` の候補は updates に一切現れない（署名を進めない＝
 *    次回再実行で再度対象になる。再開可能性）。
 * 3. `kind === "gate_degrade"` の候補は `contentHash` / `curationSignature` /
 *    `rationale` / `usefulness` を含めず、`aiSummary` / `category` / `tag` のみ
 *    更新する（`scripts/lib/backfill-plan.mjs` の buildBackfillUpdates と同じ
 *    オーナー方針）。
 */

/** markCurated() に渡してよい update のキー許可リスト（不変条件1）。 */
export const ALLOWED_UPDATE_KEYS = Object.freeze([
  "url",
  "aiSummary",
  "category",
  "tag",
  "contentHash",
  "curationSignature",
  "usefulness",
  "rationale",
]);

/**
 * 再取得＋再キュレーション後の各候補を 3 状態に分類する。
 *
 * `curateBatch()`（`src/lib/llm/batch.ts`）は topicAnchor の検証・degrade を
 * 内部で済ませ、gate に落ちた場合は `topicAnchor: null`（＋ `degradeReason`）を
 * 持つ結果を返す。したがってここでは `curateBatch` の結果を信頼し、
 * `validateTopicAnchor` の再適用はしない（判定スライスは candidate 側に無く、
 * title だけを corpus に再検証すると妥当なアンカーを誤って null 化するため）。
 *
 * @param {Array<{candidate: object, result: object|null}>} entries
 *   result は curateBatch の 1 件分の戻り値。fetch 失敗・LLM 失敗時は null。
 * @returns {Array<{candidate: object, kind: "llm_failed"|"gate_degrade"|"updated", result: object|null, finalTopicAnchor: string|null, gateReason: string|null}>}
 */
export function classifyMwedOutcomes(entries) {
  return entries.map(({ candidate, result }) => {
    if (!result) {
      return {
        candidate,
        kind: "llm_failed",
        result: null,
        finalTopicAnchor: null,
        gateReason: null,
      };
    }
    if (result.topicAnchor === null || result.topicAnchor === undefined) {
      return {
        candidate,
        kind: "gate_degrade",
        result,
        finalTopicAnchor: null,
        gateReason: result.degradeReason ?? "unknown_upstream_degrade",
      };
    }
    return {
      candidate,
      kind: "updated",
      result,
      finalTopicAnchor: result.topicAnchor,
      gateReason: null,
    };
  });
}

/**
 * `classifyMwedOutcomes()` の結果から `markCurated()` にそのまま渡せる
 * updates 配列を組み立てる。不変条件は本ファイル冒頭の JSDoc を参照。
 *
 * @param {ReturnType<typeof classifyMwedOutcomes>} outcomes
 * @param {{
 *   computeContentHash: (title: string, excerpt: string|null) => string,
 *   currentSignature: string,
 *   modelId: string,
 *   rationalePromptVersion: string,
 * }} deps
 * @returns {{ updates: object[], summary: {llmFailed: number, gateDegrade: number, updated: number}, degradeReasonCounts: Map<string, number> }}
 */
export function buildMwedUpdates(outcomes, deps) {
  const { computeContentHash, currentSignature, modelId, rationalePromptVersion } = deps;
  const summary = { llmFailed: 0, gateDegrade: 0, updated: 0 };
  const degradeReasonCounts = new Map();

  const updates = [];
  for (const o of outcomes) {
    if (o.kind === "llm_failed") {
      summary.llmFailed += 1;
      continue; // 不変条件2: updates に含めない
    }
    const { candidate: c, result } = o;
    const isDegrade = o.kind === "gate_degrade";
    if (isDegrade) {
      summary.gateDegrade += 1;
      const reason = o.gateReason ?? "unknown";
      degradeReasonCounts.set(reason, (degradeReasonCounts.get(reason) ?? 0) + 1);
    } else {
      summary.updated += 1;
    }

    // 不変条件1: キーは ALLOWED_UPDATE_KEYS のみ。判定スライスを運ぶフィールドは無い。
    // originalExcerpt は常に null 扱い（§10-5。DB の値も null のまま）。
    const update = {
      url: c.url,
      aiSummary: result.summary,
      category: result.category,
      tag: result.tag,
    };

    if (!isDegrade) {
      // 不変条件3: gate_degrade では署名を進めず、rationale / usefulness も付けない。
      update.contentHash = computeContentHash(c.originalTitle, null);
      update.curationSignature = currentSignature;
      if (c.id !== null && c.id !== undefined) {
        update.usefulness = {
          postId: c.id,
          modelId,
          criteria: {
            firsthand: result.firsthand,
            ceremonyDecision: result.ceremonyDecision,
            specific: result.specific,
            weddingDayContent: result.weddingDayContent,
            promotional: result.promotional,
          },
        };
        update.rationale = {
          postId: c.id,
          topicAnchor: o.finalTopicAnchor,
          rationaleText: result.rationaleText,
          evidenceSufficient: true,
          modelId,
          promptVersion: rationalePromptVersion,
        };
      }
    }

    updates.push(update);
  }

  return { updates, summary, degradeReasonCounts };
}

/**
 * updates 配列が不変条件1（キー許可リスト）を満たすか検証する。違反時は throw。
 * スクリプト本体が markCurated() を呼ぶ直前の最終ゲートとしても使う
 * （テストだけでなく実行時にも判定スライス漏洩を止める）。
 */
export function assertNoSliceLeak(updates) {
  for (const u of updates) {
    for (const key of Object.keys(u)) {
      if (!ALLOWED_UPDATE_KEYS.includes(key)) {
        throw new Error(
          `[mwed-anchor-backfill] 許可されていない update キー "${key}" を検出しました（§10-5: 判定スライス漏洩防止）。url=${u.url}`,
        );
      }
    }
  }
  return updates;
}
