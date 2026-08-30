/**
 * プレフライトチェック: 記事の本文（excerpt）がタイトルのみと同等（空、空白のみ、短すぎるなど）
 * である場合は、グラウンディングのコーパスがタイトルのみになり、無効なアンカー生成の原因に
 * なるため、LLM による topicAnchor の再生成をスキップして既存のアンカーを保持する。
 */
export function shouldRegenerateAnchor(input) {
  const excerpt = input?.excerpt;
  if (!excerpt) return false;
  const trimmed = typeof excerpt === "string" ? excerpt.trim() : String(excerpt).trim();
  if (trimmed === "null" || trimmed.length < 5) return false;
  return true;
}
