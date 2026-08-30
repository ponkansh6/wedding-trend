/**
 * `scripts/backfill-usefulness.mjs` の中核ロジックを、DB 接続・LLM 呼び出し・
 * `process.exit` を一切含まない純粋関数として切り出したもの。
 *
 * トップレベルスクリプトのままでは import した時点で本番 DB に接続してしまう
 * ため単体テストができない。ここに切り出すことで、以下の不変条件を単体テストで
 * 固定できるようにする:
 *
 * 1. 「shouldRegenerateAnchor() が false の候補は markCurated() に渡す
 *    updates に一切現れない」（posts の既存フィールドを NULL 上書きする退行の
 *    再発防止）。
 * 2. 「LLM 呼び出し自体が失敗した（結果が得られなかった）候補」と
 *    「LLM は成功したが validateTopicAnchor の gate に落ちた（degrade）候補」を
 *    取り違えない（ドライラン表示のサマリと個別プレビューが矛盾していた
 *    退行の再発防止。前者は Gemini の 429 等で頻発しうるため、両者を混同すると
 *    ログが読めなくなる）。
 */

/**
 * 候補配列を、プレフライト判定（`shouldRegenerateAnchor`）に基づいて
 * 「再生成対象（runnable）」と「スキップ対象（skipped）」に分割する。
 *
 * 元の `candidates` 配列内でのインデックス（`originalIndex`）を保持する。
 * これは呼び出し側が `curatePosts()` に渡す配列（runnable のみ）の結果
 * （インデックスは curatePosts への入力配列基準）を、元の候補インデックスへ
 * マッピングし直すために必要（`classifyBackfillOutcomes` の
 * `curationResultsByIndex` のキーとして使う）。
 *
 * @param {Array<{id: number|null, url: string, originalTitle: string, originalExcerpt: string|null}>} candidates
 * @param {(input: {title: string, excerpt: string|null}) => boolean} shouldRegenerateAnchor
 * @returns {{
 *   runnableCandidates: Array<{candidate: object, originalIndex: number}>,
 *   skippedCandidates: Array<{candidate: object, originalIndex: number}>,
 * }}
 */
export function partitionCandidates(candidates, shouldRegenerateAnchor) {
  const runnableCandidates = [];
  const skippedCandidates = [];

  candidates.forEach((c, index) => {
    if (shouldRegenerateAnchor({ title: c.originalTitle, excerpt: c.originalExcerpt })) {
      runnableCandidates.push({ candidate: c, originalIndex: index });
    } else {
      skippedCandidates.push({ candidate: c, originalIndex: index });
    }
  });

  return { runnableCandidates, skippedCandidates };
}

/**
 * `getStaleCurationCandidates()` が返した候補プールから、実際にこの実行で
 * 処理する対象を選び出す（Gemini 無料枠内で分割実行するための CLI
 * `--limit` / `--source` オプションに対応する純粋関数）。
 *
 * **順序が重要**: `source` によるコホート絞り込みを先に行い、その後に
 * `limit` で頭 N 件へ切り詰める。逆順（先に limit、後で source）にすると、
 * 目的のコホート（例: `--source note` で「note.com から先に流す」プラン16
 * Stage 6 の要求）が limit 適用時点で既に候補プールから溢れて消えている
 * 場合に、絞り込みの意味が失われる。
 *
 * `source` の照合は、候補オブジェクトが `sourceId` フィールドを持っていれば
 * それとの完全一致を優先し、持っていなければ `url` に対する部分一致
 * （includes）にフォールバックする。現在の `CurationCandidate`
 * （`src/lib/db/repository.ts`）は `sourceId` を持たない（この関数を追加した
 * 時点では `getStaleCurationCandidates` の SELECT に含まれていないため）ので、
 * 実運用では URL 部分一致（例: `--source note.com`）で近似的にコホートを
 * 選ぶことになる。将来 `CurationCandidate` に `sourceId` が追加されれば、
 * この関数を変更しなくても自動的に厳密一致に切り替わる。
 *
 * @param {Array<{url: string, sourceId?: string}>} candidates
 * @param {{ source?: string, limit?: number }} options
 */
export function selectCandidatesForRun(candidates, options = {}) {
  const { source, limit } = options;

  let selected = candidates;
  if (source) {
    selected = selected.filter((c) => matchesSource(c, source));
  }
  if (typeof limit === "number" && Number.isFinite(limit) && limit >= 0) {
    selected = selected.slice(0, limit);
  }
  return selected;
}

function matchesSource(candidate, source) {
  if (candidate.sourceId != null) return candidate.sourceId === source;
  return typeof candidate.url === "string" && candidate.url.includes(source);
}

/**
 * 配列を `size` 件ずつのチャンクに分割する。`size` が未指定・0 以下の場合は
 * 分割せず単一チャンクとして返す。
 *
 * `curatePosts()` 自体（`src/lib/llm/batch.ts`）の内部リトライ・並行数制御は
 * 変更しない方針のため、Gemini 無料枠（15 req/min）への配慮はこのスクリプト側で
 * 「一度に `curatePosts()` へ渡す件数を小さく保ち、チャンク間にウェイトを
 * 挟む」という形で行う。このチャンク分割自体は純粋関数として切り出し、
 * ウェイト（`setTimeout` 相当の副作用）はスクリプト本体側で行う。
 *
 * @param {Array<unknown>} array
 * @param {number} size
 */
export function chunkArray(array, size) {
  if (!size || size <= 0) return [array];
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * `runnableCandidates`（`partitionCandidates` の結果）と、それに対応する
 * LLM キュレーション結果から、各候補を次の3状態のいずれかに分類する。
 *
 * - `"llm_failed"`: `curationResultsByIndex` にその候補の結果が無い
 *   （`curatePosts()` が Gemini 429 等で失敗し、当該候補分の結果を返せなかった）。
 *   **`markCurated()` には一切渡さない**（`posts` は現状維持。次回また候補になる）。
 * - `"gate_degrade"`: LLM 呼び出し自体は成功したが、生成された `topicAnchor` が
 *   `validateTopicAnchor` の gate を通らなかった（プラン16 D5:
 *   degrade-not-drop）。`topicAnchor` のみ null にし、`aiTitle` 等の他フィールドは
 *   通常どおり更新する。
 * - `"updated"`: LLM 呼び出し・gate ともに通過した通常の更新。
 *
 * この3状態を明確に区別するのが本関数の存在意義。以前は「結果が無い
 * （llm_failed）」候補が `buildBackfillUpdates` 内で `topicAnchor: null` の
 * gate_degrade と同じ変数（`degradeReasonCounts` とは無関係だが表示ロジックが
 * `_newTopicAnchor === null` だけで判定していた）と誤って同一視され、
 * ドライランのサマリ（`gate degrade: 0 件`）と個別プレビュー（`46件が null`）が
 * 矛盾するログになっていた（本モジュールが直す対象の退行）。
 *
 * ポストフライト安全フィルター（gate degrade, プラン16 D5）はプレフライト
 * （`shouldRegenerateAnchor` / `partitionCandidates`）とは別の役割である点に
 * 注意: プレフライトは「材料が無いから生成を試みない」判定（スキップ、この
 * 関数の対象外＝既存値は一切温存）。こちらは「実際に LLM を呼んだ後」の
 * 3状態の切り分けを行う。
 *
 * @param {Array<{candidate: object, originalIndex: number}>} runnableCandidates
 * @param {Map<number, object>} curationResultsByIndex `originalIndex` → curatePosts の結果（結果が得られなかった候補は未登録）
 * @param {{
 *   validateTopicAnchor: (anchor: string, ctx: {corpus: string, title: string}) => {ok: boolean, reason?: string},
 * }} deps
 * @returns {Array<{
 *   candidate: object,
 *   originalIndex: number,
 *   kind: "llm_failed" | "gate_degrade" | "updated",
 *   result: object | null,
 *   finalTopicAnchor: string | null,
 *   gateReason: string | null,
 *   rejectedAnchors: Array<{
 *     attempt: "first" | "retry",
 *     anchor: string | null,
 *     reason: string | null,
 *     missingTerms?: string[],
 *     matchedTerms?: string[],
 *   }>,
 * }>}
 */
export function classifyBackfillOutcomes(runnableCandidates, curationResultsByIndex, deps) {
  const { validateTopicAnchor } = deps;

  return runnableCandidates.map(({ candidate: c, originalIndex: i }) => {
    const result = curationResultsByIndex.get(i);
    if (!result) {
      return {
        candidate: c,
        originalIndex: i,
        kind: "llm_failed",
        result: null,
        finalTopicAnchor: null,
        gateReason: null,
        rejectedAnchors: [],
      };
    }

    // 欠陥1の修正: src/lib/llm/batch.ts の curateAnchorWithRetry / curateBatch は
    // 自前で validateTopicAnchor を適用し、gate に落ちた場合は既に
    // `topicAnchor: null`（かつ `degradeReason` に理由コード）を持つ結果を返して
    // くることがある（「上流 degrade」）。この場合ここで改めて
    // `validateTopicAnchor(null, ...)` を呼んでも null は検証対象にならず
    // gate は発火しない（＝見抜けない）ため、"updated" に誤分類されていた
    // （ドライランのサマリと個別プレビューが矛盾した退行の直接原因）。
    // まず「上流で既に null にされていたか」を最優先で見て gate_degrade に
    // 分類し、理由コードは result.degradeReason（無ければ upstream 由来である
    // ことが分かるプレースホルダ理由）を使う。
    if (result.topicAnchor === null) {
      return {
        candidate: c,
        originalIndex: i,
        kind: "gate_degrade",
        result,
        finalTopicAnchor: null,
        gateReason: result.degradeReason ?? "unknown_upstream_degrade",
        // 追加の可視化対応: 上流（src/lib/llm/batch.ts）が既に伝播させている
        // 1回目・リトライそれぞれの「却下されたアンカー文言」と
        // missingTerms（anchor_ungrounded）/matchedTerms（anchor_prohibited_term）
        // をそのまま拾い上げる。
        rejectedAnchors: buildRejectedAnchorsFromResult(result),
      };
    }

    let finalTopicAnchor = result.topicAnchor;
    let kind = "updated";
    let gateReason = null;
    let rejectedAnchors = [];

    // 上記で null ケースを弾いた後なので、ここでは finalTopicAnchor は必ず
    // truthy（非 null 非空文字列）。それでも自前の validateTopicAnchor を
    // もう一段掛けるのは、スクリプト側が使う gate（呼び出し元から注入される
    // 関数）と上流の gate 実装が将来ズレた場合の二重防御のため。
    const corpus = `${c.originalTitle ?? ""}\n${c.originalExcerpt ?? ""}`;
    const gateRes = validateTopicAnchor(finalTopicAnchor, {
      corpus,
      title: c.originalTitle ?? "",
    });
    if (!gateRes.ok) {
      gateReason = gateRes.reason ?? "unknown";
      rejectedAnchors = [
        {
          attempt: "first",
          anchor: finalTopicAnchor,
          reason: gateReason,
          missingTerms: gateRes.missingTerms,
          matchedTerms: gateRes.matchedTerms,
        },
      ];
      finalTopicAnchor = null;
      kind = "gate_degrade";
    }

    return {
      candidate: c,
      originalIndex: i,
      kind,
      result,
      finalTopicAnchor,
      gateReason,
      rejectedAnchors,
    };
  });
}

/**
 * `CurationResult`（`src/lib/llm/batch.ts`）が既に持っている
 * `firstAttemptAnchor`/`retryAttemptAnchor` とその missingTerms/matchedTerms から、
 * 「却下されたアンカーの一覧」（1回目・リトライがそれぞれ有れば両方）を組み立てる。
 * どちらも記録が無ければ空配列（例: 上流の degrade 理由が判別できない古い形式の
 * 結果を渡された場合の後方互換）。
 */
function buildRejectedAnchorsFromResult(result) {
  const rejected = [];
  if (result.firstAttemptAnchor !== undefined && result.firstAttemptAnchor !== null) {
    rejected.push({
      attempt: "first",
      anchor: result.firstAttemptAnchor,
      reason: result.firstAttemptReason ?? null,
      missingTerms: result.firstAttemptMissingTerms,
      matchedTerms: result.firstAttemptMatchedTerms,
    });
  }
  if (result.retryAttemptAnchor !== undefined && result.retryAttemptAnchor !== null) {
    rejected.push({
      attempt: "retry",
      anchor: result.retryAttemptAnchor,
      reason: result.retryAttemptReason ?? null,
      missingTerms: result.retryAttemptMissingTerms,
      matchedTerms: result.retryAttemptMatchedTerms,
    });
  }
  return rejected;
}

/** `classifyBackfillOutcomes` の結果から、3状態それぞれの件数を集計する。 */
export function summarizeBackfillOutcomes(outcomes) {
  const summary = { llmFailed: 0, gateDegrade: 0, updated: 0 };
  for (const o of outcomes) {
    if (o.kind === "llm_failed") summary.llmFailed += 1;
    else if (o.kind === "gate_degrade") summary.gateDegrade += 1;
    else summary.updated += 1;
  }
  return summary;
}

/**
 * `classifyBackfillOutcomes` の結果から、`markCurated()` にそのまま渡せる
 * `updates` 配列を組み立てる。
 *
 * **不変条件その1**: `kind === "llm_failed"` の候補は `updates` に一切現れない
 * （`contentHash` / `curationSignature` も更新されないため、次回の
 * `getStaleCurationCandidates()` でも stale 判定に残り続け、再実行で
 * 再度キュレーションが試みられる。＝分割実行・リトライが安全に繰り返せる
 * 「再開可能性」の根拠）。
 *
 * **不変条件その2**（`partitionCandidates` 由来）: プレフライトでスキップされた
 * 候補はそもそも `outcomes` に含まれない（`runnableCandidates` にしか存在
 * しないため）。したがってこちらも `updates` に一切現れない。
 *
 * **不変条件その3（オーナー方針決定）**: `kind === "gate_degrade"` の候補は
 * `topicAnchor` が null になり `rationale` を付与しない（＝ `post_rationales`
 * は更新せず、旧アンカーを温存する）だけでなく、**`contentHash` /
 * `curationSignature` も `updates` に一切含めない**（＝ `undefined` のまま。
 * `buildPostSet` の undefined ガードにより `posts.curation_signature` は
 * 現状維持される）。理由: 署名を進めてしまうと
 * `getStaleCurationCandidates()` の stale 判定から外れ、プロンプト/gate を
 * 改善した後も**二度と再生成の機会が来なくなる**（「淡白なアンカーの永久固定」。
 * このバックフィルが直そうとしている当のバグを別の形で再現してしまう）。
 * 一方、有用度スコア（`usefulness` / `post_usefulness_criteria`）は gate_degrade でも
 * 書き込むよう緩和された（署名を `currentSignature` とする単調増加契約）。
 * これにより、アンカーがゲートに落ちた記事でも再計算済みの有用度スコアが正しく更新され、
 * 掲載順の停滞が解消される。`posts.curation_signature` は据え置かれるため、
 * 将来のアンカー再生成の機会は維持される。
 *
 * 一方 `aiTitle` / `aiSummary` / `category` / `tag` は topicAnchor の合否とは
 * 独立に正しく生成されているため、gate_degrade でも通常どおり更新する
 * （判断の詳細はこのタスクの完了報告を参照。次回の再生成でどのみち
 * 上書きされるため、gate が通るまでの間だけ本文寄りの表示を早めに改善する
 * という位置づけ）。
 *
 * `kind === "updated"` は通常どおり全フィールド。
 *
 * @param {ReturnType<typeof classifyBackfillOutcomes>} outcomes
 * @param {{
 *   computeContentHash: (title: string, excerpt: string|null) => string,
 *   currentSignature: string,
 *   modelId: string,
 *   rationalePromptVersion: string,
 *   oldAnchorByPostId?: Map<number, string|null>,
 * }} deps
 * @returns {{
 *   updates: object[],
 *   degradeReasonCounts: Map<string, number>,
 *   matchedTermCounts: Map<string, number>,
 * }}
 */
export function buildBackfillUpdates(outcomes, deps) {
  const {
    computeContentHash,
    currentSignature,
    modelId,
    rationalePromptVersion,
    oldAnchorByPostId,
  } = deps;

  const degradeReasonCounts = new Map();
  // 追加の可視化対応（要件4）: anchor_prohibited_term で実際にどの denylist
  // 項目（語 or パターンの source。src/lib/publish/gate.ts の
  // checkAnchorDenylist の matchedTerms JSDoc 参照）が何件効いたかの内訳。
  const matchedTermCounts = new Map();

  const updates = outcomes
    .filter((o) => o.kind !== "llm_failed")
    .map((o) => {
      const { candidate: c, result, finalTopicAnchor, gateReason, kind, rejectedAnchors = [] } = o;
      const isDegrade = kind === "gate_degrade";

      if (isDegrade) {
        const reason = gateReason ?? "unknown";
        degradeReasonCounts.set(reason, (degradeReasonCounts.get(reason) ?? 0) + 1);
        for (const rejected of rejectedAnchors) {
          for (const term of rejected.matchedTerms ?? []) {
            matchedTermCounts.set(term, (matchedTermCounts.get(term) ?? 0) + 1);
          }
        }
      }

      return {
        url: c.url,
        aiTitle: result.title,
        aiSummary: result.summary,
        category: result.category,
        tag: result.tag,
        // 不変条件その3: gate_degrade では contentHash / curationSignature を
        // 一切含めない（undefined のまま）。posts.curation_signature を進めず、
        // 次回また再生成の候補として残す。
        ...(isDegrade
          ? {}
          : {
              contentHash: computeContentHash(c.originalTitle, c.originalExcerpt),
              curationSignature: currentSignature,
            }),
        _kind: kind,
        _oldTopicAnchor: c.id !== null ? (oldAnchorByPostId?.get(c.id) ?? null) : null,
        _newTopicAnchor: finalTopicAnchor,
        _gateReason: gateReason,
        _rejectedAnchors: rejectedAnchors,
        // 有用度: gate_degrade でも usefulness は signature を `currentSignature` として
        // 書き込む（単調増加契約）。posts.curation_signature は進めないが、有用度スコアは
        // 正しく最新化する。
        usefulness:
          c.id !== null
            ? {
                postId: c.id,
                modelId,
                signature: currentSignature,
                criteria: {
                  firsthand: result.firsthand,
                  ceremonyDecision: result.ceremonyDecision,
                  specific: result.specific,
                  weddingDayContent: result.weddingDayContent,
                  promotional: result.promotional,
                },
              }
            : undefined,
        rationale:
          c.id !== null && finalTopicAnchor !== null
            ? {
                postId: c.id,
                topicAnchor: finalTopicAnchor,
                rationaleText: result.rationaleText,
                evidenceSufficient: true,
                modelId,
                promptVersion: rationalePromptVersion,
              }
            : undefined,
      };
    });

  return { updates, degradeReasonCounts, matchedTermCounts };
}

/** `updates` から dry-run 専用フィールド（`_oldTopicAnchor` / `_newTopicAnchor` / `_kind` / `_gateReason` / `_rejectedAnchors`）を除いた、`markCurated()` にそのまま渡せる配列を返す。 */
export function toMarkCuratedInput(updates) {
  return updates.map((u) => {
    const rest = { ...u };
    delete rest._oldTopicAnchor;
    delete rest._newTopicAnchor;
    delete rest._kind;
    delete rest._gateReason;
    delete rest._rejectedAnchors;
    return rest;
  });
}
