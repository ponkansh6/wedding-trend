/**
 * @file src/lib/types/judgment.ts
 * @purpose LLM判定用のエフェメラルな抽出テキストを表すブランデッド型（S3型保証）。
 *          リポジトリやデータベーススキーマ層から絶対にインポートしてはならない。
 *          INV-6: 本文非永続化 — DB挿入型は本文型と交わらない（S3型保証）。
 */

/**
 * 抽出された記事本文スライス（LLM判定燃料）。
 * ブランデッド型により、`posts` テーブル等の `originalExcerpt` やその他の永続化カラムへ
 * 誤って直接渡すことをコンパイル時に完全に防止する。
 */
export type EphemeralArticleSlice = string & { readonly __brand: unique symbol };

/**
 * 非エフェメラルな通常の文字列型（センチネル付き）。
 * DB 挿入層（PostUpsertInput 等）において `EphemeralArticleSlice` が誤って代入されることを
 * 型レベルでブロックするために使用する。通常の `string` や `null` はこの型に代入可能であるが、
 * `EphemeralArticleSlice` は代入不能（コンパイルエラーとなる）。
 *
 * ⚠️ S3 型保証の要件により、`EphemeralArticleSlice` と同じキー `__brand` を持ちつつ
 * オプショナルな `never` として定義することで、`EphemeralArticleSlice` の持つ
 * 必須の `readonly __brand: unique symbol` とコンフリクトさせ、代入を完全に拒絶する。
 */
export type NonEphemeralString = string & { readonly __brand?: never };

/**
 * 任意の文字列を EphemeralArticleSlice に変換する安全なキャスト関数。
 * パイプライン層（discovery-ingest等）でのみ呼び出し、データベース層のインポートは禁止。
 *
 * @example
 * ```ts
 * const slice = createEphemeralSlice("article body text...");
 * // 以下の代入は PostUpsertInput.originalExcerpt が NonEphemeralString を要求するためコンパイルエラーになる:
 * // const badInput: PostUpsertInput = { originalExcerpt: slice };
 * ```
 */
export function createEphemeralSlice(text: string): EphemeralArticleSlice {
  return text as EphemeralArticleSlice;
}
