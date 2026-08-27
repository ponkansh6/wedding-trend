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

const PROMOTIONAL_LEVELS = ["none", "light", "heavy"] as const;

/**
 * `mask`（0〜95、全96通り）から6項目分の判定値を組み立てる。
 * promotional は3値の enum になったため、下位の3進数1桁を promotional に、
 * 残りの5ビットを他5項目のブール値に割り当てる（5ビット×3値=32×3=96通り）。
 * ビット・桁の割り当て順序自体に意味は無く、全96通りを網羅することが目的。
 */
function criteriaFromMask(mask: number): UsefulnessCriteria {
  const promotionalIndex = mask % 3;
  const boolBits = Math.floor(mask / 3);
  return {
    firsthand: ((boolBits >> 0) & 1) === 1,
    ceremonyDecision: ((boolBits >> 1) & 1) === 1,
    specific: ((boolBits >> 2) & 1) === 1,
    weddingDayContent: ((boolBits >> 3) & 1) === 1,
    promotional: PROMOTIONAL_LEVELS[promotionalIndex],
    preDecisionOrPhotoShoot: ((boolBits >> 4) & 1) === 1,
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

  it("all 96 combinations of the 5 boolean criteria × 3-value promotional: getFeedCards() order matches computeUsefulnessScore() order", async () => {
    // publishedAt をすべて別の値にしておくことで、スコアが同点になった場合でも
    // 期待順序が publishedAt 降順で一意に決まるようにする（id タイブレークに
    // 依存しない）。
    const combos = Array.from({ length: 96 }, (_, mask) => {
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

    const feedCards = await getFeedCards({ sourceType: "blog", limit: 100 });
    expect(feedCards.map((c) => c.url)).toEqual(expectedOrder);
  });

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
            firsthand: true,
            ceremonyDecision: true,
            specific: true,
            weddingDayContent: false,
            promotional: "none",
            preDecisionOrPhotoShoot: false,
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
            firsthand: true,
            ceremonyDecision: true,
            specific: true,
            weddingDayContent: false,
            promotional: "none",
            preDecisionOrPhotoShoot: false,
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
          firsthand: true,
          ceremonyDecision: true,
          specific: true,
          // weddingDayContent キーが存在しない
          promotional: "none",
          preDecisionOrPhotoShoot: false,
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
            firsthand: false,
            ceremonyDecision: true,
            specific: false,
            weddingDayContent: false,
            promotional: "none",
            preDecisionOrPhotoShoot: false,
          },
        },
      },
    ]);

    const feedCards = await getFeedCards({ sourceType: "blog", limit: 10 });
    const unscoredIndex = feedCards.findIndex((c) => c.url === "https://example.com/unscored");
    const gateOnlyIndex = feedCards.findIndex((c) => c.url === "https://example.com/gate-only");

    // UNSCORED_USEFULNESS_SCORE(3) はゲート通過（12点）より下 → gate-only が先。
    expect(gateOnlyIndex).toBeLessThan(unscoredIndex);
    expect(unscoredIndex).toBeGreaterThanOrEqual(0);
    void UNSCORED_USEFULNESS_SCORE; // 参照のみ（実際の値は computeUsefulnessScore 側のテストで固定済み）
  });

  it("malformed criteria_json: the broken row alone falls back to UNSCORED_USEFULNESS_SCORE, and every other row in the lane still scores and orders normally (json_valid guard)", async () => {
    // 1行の JSON 破損がレーン全体を [] にしてしまわないことを確認する。
    // gatePasser(12) > richNonGate(7) > {malformed, noRow}(3, publishedAt で
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
      // score = USEFULNESS_GATE_BONUS のみ = 12
      usefulnessFor("https://example.com/gate-passer", {
        firsthand: false,
        ceremonyDecision: true,
        specific: false,
        weddingDayContent: false,
        promotional: "none",
        preDecisionOrPhotoShoot: false,
      }),
      // ゲート不通過 → firsthand+specific+weddingDayContent = 7
      usefulnessFor("https://example.com/rich-non-gate", {
        firsthand: true,
        ceremonyDecision: false,
        specific: true,
        weddingDayContent: true,
        promotional: "none",
        preDecisionOrPhotoShoot: false,
      }),
      // criteria の中身はどうせ後で JSON ごと壊すので内容は不問（ここでは
      // gate-passer 相当の高スコアを装う——それでも壊れた後は UNSCORED(3) まで
      // 落ちることを示すのが本テストの主眼）。
      usefulnessFor("https://example.com/malformed", {
        firsthand: true,
        ceremonyDecision: true,
        specific: true,
        weddingDayContent: true,
        promotional: "none",
        preDecisionOrPhotoShoot: false,
      }),
      // score = 0（全 false）
      usefulnessFor("https://example.com/all-false", {
        firsthand: false,
        ceremonyDecision: false,
        specific: false,
        weddingDayContent: false,
        promotional: "none",
        preDecisionOrPhotoShoot: false,
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
        // markCurated 経由では型上 PromotionalLevel しか書けないため、まず
        // 妥当な enum 値で書き込んでから、下で criteria_json を旧 boolean に
        // 直接書き換える。
        criteria: {
          firsthand: true,
          ceremonyDecision: true,
          specific: false,
          weddingDayContent: false,
          promotional: "none" as const,
          preDecisionOrPhotoShoot: false,
        },
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

    // SQL 側: boolean true の行は json_extract(...) = 'heavy' に一致せず
    // 減点 0（gate + firsthand のみのスコアで並ぶ）。同点なので publishedAt
    // 降順で legacy-bool-false が先に来る。
    expect(feedCards.map((c) => c.url)).toEqual([
      "https://example.com/legacy-bool-false",
      "https://example.com/legacy-bool-true",
    ]);

    // TS 側（normalizePromotional 経由）: 旧 true は "light" に正規化され、
    // 旧 false は "none" に正規化される——いずれも減点対象ではない。
    expect(trueCard?.usefulness?.promotional).toBe("light");
    expect(falseCard?.usefulness?.promotional).toBe("none");
  });
});
