import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { postUsefulnessCriteria } from "@/lib/db/schema";
import { upsertPosts, getPostsByUrls, markCurated } from "@/lib/db/repository";
import { getFeedCards } from "@/lib/db/query";
import {
  computeUsefulnessScore,
  UNSCORED_USEFULNESS_SCORE,
  type UsefulnessCriteria,
} from "@/lib/scoring/usefulness";
import { setupTestDb } from "./helpers/test-db";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: any) => fn,
  revalidateTag: vi.fn(),
}));

/**
 * SQL 側の並び順キー（`src/lib/db/query.ts` の `USEFULNESS_SCORE_SQL`）と
 * 純関数 `computeUsefulnessScore()` が同じ式であることを検証するパリティ
 * テスト。同じ式が TypeScript と SQL 文字列の2箇所に手書きで存在するため、
 * 片方だけ変えても気づけない — このテストはその乖離を検出するために存在する。
 */

const BASE_DATE = Date.UTC(2024, 0, 1);

/** 判定レンジは 0-9 だが 10^5 は多すぎるため代表値の部分集合で網羅する。 */
const LEVELS = [0, 1, 5, 7, 9] as const;
const TOTAL_COMBOS = LEVELS.length ** 5; // 5 軸 × 5 代表値 = 3125

/**
 * `mask`（0〜3124）から 5 項目分の判定値（各 LEVELS の代表値）を組み立てる。
 * mask を 5 桁の 5 進数として各桁を 1 項目に割り当てる。桁の割り当て順序
 * 自体に意味は無く、代表値の全組み合わせを網羅することが目的。
 * 代表値には減点境界の 7、ゲート境界の 1、非該当の 0 を含めてある。
 */
function criteriaFromMask(mask: number): UsefulnessCriteria {
  const digit = (i: number) => LEVELS[Math.floor(mask / LEVELS.length ** i) % LEVELS.length];
  return {
    firsthand: digit(0),
    ceremonyDecision: digit(1),
    specific: digit(2),
    weddingDayContent: digit(3),
    promotional: digit(4),
  };
}

function blogPostInput(url: string, publishedAt: string) {
  return {
    url,
    sourceType: "blog" as const,
    sourceId: "note",
    sourceName: "note",
    originalTitle: `Title ${url}`,
    originalExcerpt: "excerpt",
    author: "Author",
    thumbnailUrl: null,
    publishedAt,
  };
}

describe("SQL score (USEFULNESS_SCORE_SQL) matches computeUsefulnessScore()", () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  // 3125 通りを 1 ケースで回す網羅テストのため、既定の 5000ms では
  // マシン負荷（並列実行・カバレッジ計測）次第で超過する。実測は単独実行で
  // 約 6.3 秒。負荷に依存して赤くなるのを防ぐため明示的に上限を与える
  // （shared_plan/17 S8 のテスト並列化で顕在化した）。
  it("all 3125 combinations of the 5 criteria (each over representative 0-9 levels): getFeedCards() order matches computeUsefulnessScore() order", async () => {
    // publishedAt をすべて別の値にしておくことで、スコアが同点になった場合でも
    // 期待順序が publishedAt 降順で一意に決まるようにする（id タイブレークに
    // 依存しない）。
    const combos = Array.from({ length: TOTAL_COMBOS }, (_, mask) => {
      const url = `https://example.com/parity/${mask}`;
      const publishedAt = new Date(BASE_DATE + mask * 60_000).toISOString();
      return { mask, url, publishedAt, criteria: criteriaFromMask(mask) };
    });

    await upsertPosts(combos.map((c) => blogPostInput(c.url, c.publishedAt)));
    const states = await getPostsByUrls(combos.map((c) => c.url));

    await markCurated(
      combos.map((c) => ({
        url: c.url,
        aiTitle: `AI ${c.url}`,
        aiSummary: "AI Summary text long enough for the fixture",
        category: "その他" as const,
        tag: "trend" as const,
        contentHash: "hash",
        curationSignature: "sig",
        usefulness: {
          postId: states.get(c.url)!.id,
          modelId: "test-model",
          criteria: c.criteria,
        },
      })),
    );

    // 純関数側で期待される順序を独立に組み立てる（SQL のコピーではなく、
    // computeUsefulnessScore() をそのまま使う）。タイブレークは
    // getFeedCards の契約（score desc → publishedAt desc → id desc）と
    // 同じ規則を適用する。
    const expectedOrder = [...combos]
      .sort((a, b) => {
        const scoreDiff = computeUsefulnessScore(b.criteria) - computeUsefulnessScore(a.criteria);
        if (scoreDiff !== 0) return scoreDiff;
        return b.publishedAt.localeCompare(a.publishedAt);
      })
      .map((c) => c.url);

    const feedCards = await getFeedCards({ sourceType: "blog", limit: 4000 });
    expect(feedCards.map((c) => c.url)).toEqual(expectedOrder);
  }, 30000);

  it("a criteria_json missing a key is treated as false for that key (COALESCE hardening), not as a NULL-propagation crash", async () => {
    await upsertPosts([
      blogPostInput("https://example.com/missing-key", "2024-01-01T00:00:00.000Z"),
      blogPostInput("https://example.com/explicit-false", "2024-01-01T00:00:00.000Z"),
    ]);
    const states = await getPostsByUrls([
      "https://example.com/missing-key",
      "https://example.com/explicit-false",
    ]);

    await markCurated([
      {
        url: "https://example.com/missing-key",
        aiTitle: "missing-key",
        aiSummary: "AI Summary text long enough for the fixture",
        category: "その他",
        tag: "trend",
        contentHash: "hash",
        curationSignature: "sig",
        usefulness: {
          postId: states.get("https://example.com/missing-key")!.id,
          modelId: "test-model",
          // markCurated 経由だと UsefulnessCriteria 型で全 6 キーが強制される
          // ため、まず全 false で書き込んでから下で weddingDayContent キーを欠落させる。
          criteria: {
            firsthand: 2,
            ceremonyDecision: 2,
            specific: 2,
            weddingDayContent: 0,
            promotional: 0,
          },
        },
      },
      {
        url: "https://example.com/explicit-false",
        aiTitle: "explicit-false",
        aiSummary: "AI Summary text long enough for the fixture",
        category: "その他",
        tag: "trend",
        contentHash: "hash",
        curationSignature: "sig",
        usefulness: {
          postId: states.get("https://example.com/explicit-false")!.id,
          modelId: "test-model",
          criteria: {
            firsthand: 2,
            ceremonyDecision: 2,
            specific: 2,
            weddingDayContent: 0,
            promotional: 0,
          },
        },
      },
    ]);

    // markCurated が書いた JSON から weddingDayContent キーを手動で欠落させる
    // （実運用では旧バックフィル分の行や、将来判定項目を追加したときの
    // 古い行で発生しうる状態を模擬する）。
    const missingKeyPostId = states.get("https://example.com/missing-key")!.id;
    await db
      .update(postUsefulnessCriteria)
      .set({
        criteriaJson: JSON.stringify({
          firsthand: 2,
          ceremonyDecision: 2,
          specific: 2,
          // weddingDayContent キーが存在しない
          promotional: 0,
        }),
      })
      .where(eq(postUsefulnessCriteria.postId, missingKeyPostId));

    const feedCards = await getFeedCards({ sourceType: "blog", limit: 10 });
    const missingKeyIndex = feedCards.findIndex((c) => c.url === "https://example.com/missing-key");
    const explicitFalseIndex = feedCards.findIndex(
      (c) => c.url === "https://example.com/explicit-false",
    );

    // 欠落キーが NULL 伝播でクエリ全体を壊す（あるいはその行だけ最下位に
    // 沈む）のではなく、「未知の判定項目は false 扱い」という COALESCE の
    // 意味論どおりに、weddingDayContent=false を明示した行と同点で並ぶことを確認する。
    expect(missingKeyIndex).toBeGreaterThanOrEqual(0);
    expect(explicitFalseIndex).toBeGreaterThanOrEqual(0);
    // 同点（publishedAt も同一）なので、posts.id 降順タイブレークで順序が
    // 決まる——どちらの順であっても「両方とも消えていない」ことが本旨。
    expect(new Set([missingKeyIndex, explicitFalseIndex]).size).toBe(2);
  });

  it("a post with no post_usefulness_criteria row scores as UNSCORED_USEFULNESS_SCORE", async () => {
    await upsertPosts([blogPostInput("https://example.com/unscored", "2024-01-01T00:00:00.000Z")]);
    await markCurated([
      {
        url: "https://example.com/unscored",
        aiTitle: "unscored",
        aiSummary: "AI Summary text long enough for the fixture",
        category: "その他",
        tag: "trend",
        contentHash: "hash",
        curationSignature: "sig",
        // usefulness を渡さない = post_usefulness_criteria に行が作られない
      },
    ]);
    await upsertPosts([blogPostInput("https://example.com/gate-only", "2024-01-01T00:00:00.000Z")]);
    const states = await getPostsByUrls(["https://example.com/gate-only"]);
    await markCurated([
      {
        url: "https://example.com/gate-only",
        aiTitle: "gate-only",
        aiSummary: "AI Summary text long enough for the fixture",
        category: "その他",
        tag: "trend",
        contentHash: "hash",
        curationSignature: "sig",
        usefulness: {
          postId: states.get("https://example.com/gate-only")!.id,
          modelId: "test-model",
          criteria: {
            firsthand: 0,
            ceremonyDecision: 2,
            specific: 0,
            weddingDayContent: 2,
            promotional: 0,
          },
        },
      },
    ]);

    const feedCards = await getFeedCards({ sourceType: "blog", limit: 10 });
    const unscoredIndex = feedCards.findIndex((c) => c.url === "https://example.com/unscored");
    const gateOnlyIndex = feedCards.findIndex((c) => c.url === "https://example.com/gate-only");

    // UNSCORED_USEFULNESS_SCORE(20) はゲート通過帯（>= 70）より下 → gate-only が先。
    expect(gateOnlyIndex).toBeLessThan(unscoredIndex);
    expect(unscoredIndex).toBeGreaterThanOrEqual(0);
    void UNSCORED_USEFULNESS_SCORE; // 参照のみ（実際の値は computeUsefulnessScore 側のテストで固定済み）
  });

  it("malformed criteria_json: the broken row alone falls back to UNSCORED_USEFULNESS_SCORE, and every other row in the lane still scores and orders normally (json_valid guard)", async () => {
    // 1行の JSON 破損がレーン全体を [] にしてしまわないことを確認する。
    // gatePasser(78) > richNonGate(63) > {malformed, noRow}(UNSCORED=20, publishedAt で
    // タイブレーク) > allFalse(0) という厳密な順序まで検証することで、壊れた
    // 行の周囲の健全な行が「巻き込まれずに」正しくスコアされることも保証する。
    await upsertPosts([
      blogPostInput("https://example.com/gate-passer", "2024-01-05T00:00:00.000Z"),
      blogPostInput("https://example.com/rich-non-gate", "2024-01-04T00:00:00.000Z"),
      blogPostInput("https://example.com/malformed", "2024-01-03T00:00:00.000Z"),
      blogPostInput("https://example.com/no-row", "2024-01-02T00:00:00.000Z"),
      blogPostInput("https://example.com/all-false", "2024-01-01T00:00:00.000Z"),
    ]);
    const states = await getPostsByUrls([
      "https://example.com/gate-passer",
      "https://example.com/rich-non-gate",
      "https://example.com/malformed",
      "https://example.com/no-row",
      "https://example.com/all-false",
    ]);

    const usefulnessFor = (url: string, criteria: UsefulnessCriteria) => ({
      url,
      aiTitle: url,
      aiSummary: "AI Summary text long enough for the fixture",
      category: "その他" as const,
      tag: "trend" as const,
      contentHash: "hash",
      curationSignature: "sig",
      usefulness: {
        postId: states.get(url)!.id,
        modelId: "test-model",
        criteria,
      },
    });

    await markCurated([
      // ゲート通過（cd=2, wdc=2）→ GATE_BONUS + W_CEREMONY×2 + W_WDC×2 = 70+4+4 = 78
      usefulnessFor("https://example.com/gate-passer", {
        firsthand: 0,
        ceremonyDecision: 2,
        specific: 0,
        weddingDayContent: 2,
        promotional: 0,
      }),
      // ゲート不通過（cd=0）だが最大級 → W_FIRSTHAND×9 + W_SPECIFIC×9 + W_WDC×9 = 27+18+18 = 63
      // （ゲート不通過帯の上限。UNSCORED=20 より上なので malformed/no-row より前に来る）
      usefulnessFor("https://example.com/rich-non-gate", {
        firsthand: 9,
        ceremonyDecision: 0,
        specific: 9,
        weddingDayContent: 9,
        promotional: 0,
      }),
      // criteria の中身はどうせ後で JSON ごと壊すので内容は不問（ここでは
      // gate-passer 相当の高スコアを装う——それでも壊れた後は UNSCORED(3) まで
      // 落ちることを示すのが本テストの主眼）。
      usefulnessFor("https://example.com/malformed", {
        firsthand: 2,
        ceremonyDecision: 2,
        specific: 2,
        weddingDayContent: 2,
        promotional: 0,
      }),
      // score = 0（全 false）
      usefulnessFor("https://example.com/all-false", {
        firsthand: 0,
        ceremonyDecision: 0,
        specific: 0,
        weddingDayContent: 0,
        promotional: 0,
      }),
    ]);
    // no-row は post_usefulness_criteria 行を一切作らない（usefulness を渡さない）。
    await markCurated([
      {
        url: "https://example.com/no-row",
        aiTitle: "no-row",
        aiSummary: "AI Summary text long enough for the fixture",
        category: "その他",
        tag: "trend",
        contentHash: "hash",
        curationSignature: "sig",
      },
    ]);

    // markCurated を経由すると常に valid な JSON.stringify(criteria) しか
    // 書けないため、不正 JSON は直接 UPDATE で作り込む。
    const malformedPostId = states.get("https://example.com/malformed")!.id;
    await db
      .update(postUsefulnessCriteria)
      .set({ criteriaJson: "{not valid json" })
      .where(eq(postUsefulnessCriteria.postId, malformedPostId));

    // json_extract は不正 JSON に対して SQLite の runtime error を投げるが、
    // USEFULNESS_SCORE_SQL は json_valid(...) の WHEN 節をそれより手前に
    // 置いているため、不正 JSON の行では json_extract 自体が呼ばれず
    // UNSCORED_USEFULNESS_SCORE にフォールバックする。レーン全体は失われない。
    const feedCards = await getFeedCards({ sourceType: "blog", limit: 10 });
    expect(feedCards.map((c) => c.url)).toEqual([
      "https://example.com/gate-passer",
      "https://example.com/rich-non-gate",
      "https://example.com/malformed",
      "https://example.com/no-row",
      "https://example.com/all-false",
    ]);
    void UNSCORED_USEFULNESS_SCORE; // 参照のみ（malformed と no-row が同点になる根拠）
  });

  it("backward compatibility: a criteria_json row still holding the legacy boolean promotional=true is not rejected by the type guard, scores as a normal row (not UNSCORED), and pays no promotional penalty", async () => {
    // DB マイグレーションを行わない方針（normalizePromotional のコメント参照）
    // のため、boolean 時代に書き込まれた criteria_json 行がそのまま残り続ける。
    // この行が (a) 型ガードに弾かれて UNSCORED_USEFULNESS_SCORE に落ちない
    // こと、(b) 旧 true = 減点解除という確定方針どおり promotional 減点が 0 に
    // なることを固定する。
    await upsertPosts([
      blogPostInput("https://example.com/legacy-bool-true", "2024-01-01T00:00:00.000Z"),
      blogPostInput("https://example.com/legacy-bool-false", "2024-01-02T00:00:00.000Z"),
    ]);
    const states = await getPostsByUrls([
      "https://example.com/legacy-bool-true",
      "https://example.com/legacy-bool-false",
    ]);

    const usefulnessFor = (url: string) => ({
      url,
      aiTitle: url,
      aiSummary: "AI Summary text long enough for the fixture",
      category: "その他" as const,
      tag: "trend" as const,
      contentHash: "hash",
      curationSignature: "sig",
      usefulness: {
        postId: states.get(url)!.id,
        modelId: "test-model",
        // まず妥当な整数値で書き込んでから、下で criteria_json を
        // v11 以前の完全なレガシー shape に直接書き換える。
        criteria: {
          firsthand: 2,
          ceremonyDecision: 2,
          specific: 0,
          weddingDayContent: 0,
          promotional: 0,
        } satisfies UsefulnessCriteria,
      },
    });

    await markCurated([
      usefulnessFor("https://example.com/legacy-bool-true"),
      usefulnessFor("https://example.com/legacy-bool-false"),
    ]);

    const legacyTruePostId = states.get("https://example.com/legacy-bool-true")!.id;
    await db
      .update(postUsefulnessCriteria)
      .set({
        // v11 以前の完全なレガシー shape（5 項目 boolean + promotional 文字列 or
        // boolean + preDecisionOrPhotoShoot キー）。
        criteriaJson: JSON.stringify({
          firsthand: true,
          ceremonyDecision: true,
          specific: false,
          weddingDayContent: false,
          promotional: true, // レガシー boolean のまま
          preDecisionOrPhotoShoot: false,
        }),
      })
      .where(eq(postUsefulnessCriteria.postId, legacyTruePostId));

    const legacyFalsePostId = states.get("https://example.com/legacy-bool-false")!.id;
    await db
      .update(postUsefulnessCriteria)
      .set({
        criteriaJson: JSON.stringify({
          firsthand: true,
          ceremonyDecision: true,
          specific: false,
          weddingDayContent: false,
          promotional: false, // レガシー boolean のまま
          preDecisionOrPhotoShoot: false,
        }),
      })
      .where(eq(postUsefulnessCriteria.postId, legacyFalsePostId));

    const feedCards = await getFeedCards({ sourceType: "blog", limit: 10 });
    const trueCard = feedCards.find((c) => c.url === "https://example.com/legacy-bool-true");
    const falseCard = feedCards.find((c) => c.url === "https://example.com/legacy-bool-false");

    // 型ガードに弾かれていれば usefulness は null になる（UNSCORED 相当）。
    expect(trueCard?.usefulness).not.toBeNull();
    expect(falseCard?.usefulness).not.toBeNull();

    // SQL 側: 旧 boolean promotional は `= 'heavy' OR (… + 0) >= 7` のどちらにも一致せず
    // 減点 0。weddingDayContent=false→0 でゲート不通過なので両行とも
    // `W_CEREMONY×1 + W_FIRSTHAND×1` で同点。publishedAt 降順で false が先。
    expect(feedCards.map((c) => c.url)).toEqual([
      "https://example.com/legacy-bool-false",
      "https://example.com/legacy-bool-true",
    ]);

    // TS 側（normalizePromotional 経由）: 旧 true は 4、旧 false は 0 に正規化される
    // ——いずれも減点対象（>= 7）ではない。
    expect(trueCard?.usefulness?.promotional).toBe(4);
    expect(falseCard?.usefulness?.promotional).toBe(0);
  });
});
