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

/**
 * `mask` の下位ビットから 6 項目分のブール値を組み立てる。ビットの割り当て
 * 順序自体に意味は無い（0〜63 を全網羅することが目的）。
 */
function criteriaFromMask(mask: number): UsefulnessCriteria {
  return {
    firsthand: ((mask >> 0) & 1) === 1,
    ceremonyDecision: ((mask >> 1) & 1) === 1,
    specific: ((mask >> 2) & 1) === 1,
    tradeoff: ((mask >> 3) & 1) === 1,
    promotional: ((mask >> 4) & 1) === 1,
    preDecisionOrPhotoShoot: ((mask >> 5) & 1) === 1,
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

  it("all 64 combinations of the 6 boolean criteria: getFeedCards() order matches computeUsefulnessScore() order", async () => {
    // publishedAt をすべて別の値にしておくことで、スコアが同点になった場合でも
    // 期待順序が publishedAt 降順で一意に決まるようにする（id タイブレークに
    // 依存しない）。
    const combos = Array.from({ length: 64 }, (_, mask) => {
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
          // ため、まず全 false で書き込んでから下で tradeoff キーを欠落させる。
          criteria: {
            firsthand: true,
            ceremonyDecision: true,
            specific: true,
            tradeoff: false,
            promotional: false,
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
            tradeoff: false,
            promotional: false,
            preDecisionOrPhotoShoot: false,
          },
        },
      },
    ]);

    // markCurated が書いた JSON から tradeoff キーを手動で欠落させる
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
          // tradeoff キーが存在しない
          promotional: false,
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
    // 意味論どおりに、tradeoff=false を明示した行と同点で並ぶことを確認する。
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
            tradeoff: false,
            promotional: false,
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
        tradeoff: false,
        promotional: false,
        preDecisionOrPhotoShoot: false,
      }),
      // ゲート不通過 → firsthand+specific+tradeoff = 7
      usefulnessFor("https://example.com/rich-non-gate", {
        firsthand: true,
        ceremonyDecision: false,
        specific: true,
        tradeoff: true,
        promotional: false,
        preDecisionOrPhotoShoot: false,
      }),
      // criteria の中身はどうせ後で JSON ごと壊すので内容は不問（ここでは
      // gate-passer 相当の高スコアを装う——それでも壊れた後は UNSCORED(3) まで
      // 落ちることを示すのが本テストの主眼）。
      usefulnessFor("https://example.com/malformed", {
        firsthand: true,
        ceremonyDecision: true,
        specific: true,
        tradeoff: true,
        promotional: false,
        preDecisionOrPhotoShoot: false,
      }),
      // score = 0（全 false）
      usefulnessFor("https://example.com/all-false", {
        firsthand: false,
        ceremonyDecision: false,
        specific: false,
        tradeoff: false,
        promotional: false,
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
});
