import { createHash } from "node:crypto";
import { extractArticleContainer, extractVisibleText } from "@/lib/sources/article-text";

const SIMHASH_BITS = 64;
/** 64bit を BigInt を使わず 32bit の word 2 つで扱う（tsconfig target=ES2017 対応）。 */
const WORD_BITS = 32;
const SHINGLE_SIZE = 4;

function shingles(text: string): string[] {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < SHINGLE_SIZE) return compact.length > 0 ? [compact] : [];
  const out: string[] = [];
  for (let i = 0; i <= compact.length - SHINGLE_SIZE; i++) {
    out.push(compact.slice(i, i + SHINGLE_SIZE));
  }
  return out;
}

/** sha256 digest の先頭 8 バイトを 32bit word 2 つ（符号なし）に変換する。 */
function tokenFingerprintWords(token: string): [number, number] {
  const digest = createHash("sha256").update(token).digest();
  const w0 = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  const w1 = ((digest[4] << 24) | (digest[5] << 16) | (digest[6] << 8) | digest[7]) >>> 0;
  return [w0, w1];
}

export function computeBodyHash(text: string): string {
  const tokens = shingles(text);
  if (tokens.length === 0) return "0".repeat(16);

  const weights0 = Array.from({ length: WORD_BITS }, () => 0);
  const weights1 = Array.from({ length: WORD_BITS }, () => 0);
  for (const token of tokens) {
    const [w0, w1] = tokenFingerprintWords(token);
    for (let bit = 0; bit < WORD_BITS; bit++) {
      weights0[bit] += ((w0 >>> bit) & 1) === 1 ? 1 : -1;
      weights1[bit] += ((w1 >>> bit) & 1) === 1 ? 1 : -1;
    }
  }

  let r0 = 0;
  let r1 = 0;
  for (let bit = 0; bit < WORD_BITS; bit++) {
    if (weights0[bit] > 0) r0 |= 1 << bit;
    if (weights1[bit] > 0) r1 |= 1 << bit;
  }
  return (r0 >>> 0).toString(16).padStart(8, "0") + (r1 >>> 0).toString(16).padStart(8, "0");
}

function popcount32(value: number): number {
  let v = value >>> 0;
  let count = 0;
  while (v) {
    count += v & 1;
    v >>>= 1;
  }
  return count;
}

/** 2つの simhash（16桁 hex）間の近似類似度（0〜1）。ハミング距離が小さいほど 1 に近い。 */
export function bodyHashSimilarity(a: string, b: string): number {
  if (
    a.length !== 16 ||
    b.length !== 16 ||
    !/^[0-9a-f]{16}$/i.test(a) ||
    !/^[0-9a-f]{16}$/i.test(b)
  ) {
    // 不正な hex（旧データ等）は最も安全側（=別物扱い）に倒す。
    return 0;
  }
  const a0 = Number.parseInt(a.slice(0, 8), 16);
  const a1 = Number.parseInt(a.slice(8, 16), 16);
  const b0 = Number.parseInt(b.slice(0, 8), 16);
  const b1 = Number.parseInt(b.slice(8, 16), 16);
  const distance = popcount32(a0 ^ b0) + popcount32(a1 ^ b1);
  return 1 - distance / SIMHASH_BITS;
}

/**
 * ホスト別の抽出設定（articleContainerSelectors）に基づき HTML から記事コンテナを
 * 抽出し、可視テキスト化して simhash 本文ハッシュを計算する。
 *
 * `extractArticleContainer()` がホストのセレクタに一致せず `null` を返した
 * 場合、この関数も `null` を返す。呼び出し側はページ全体へフォールバック
 * してはならない（それは本来のコンテナ基準ハッシュと構造的に食い違う値を
 * 生成し、以後の全比較を破壊する）。
 */
export function computeContainerBodyHash(html: string, host: string): string | null {
  const containerHtml = extractArticleContainer(html, host);
  if (containerHtml === null) return null;
  return computeBodyHash(extractVisibleText(containerHtml));
}
