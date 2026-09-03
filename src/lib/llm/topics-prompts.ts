// Removed unused CurationInput import
export interface TopicCurationInput {
  id: string;
  title: string;
  slice: string; // memory-only max 1500 chars
}

/**
 * Topics-only LLM prompts complying with shared_plan/23 §4.
 */
export function buildTopicsBatchPrompt(inputs: TopicCurationInput[]): string {
  const itemsJson = inputs.map((item, idx) => ({
    index: idx + 1,
    id: item.id,
    title: item.title,
    slice: item.slice,
  }));

  return `あなたは結婚式トレンド記事のコンテンツアナリストです。提供された複数の記事情報（タイトルと本文の判定スライス）から、各記事の主題を表すトピックタグ（0〜4個）を抽出・生成してください。

## ルール
1. **出力形式**: 以下の JSON 形式で返すこと。Markdown の \`\`\`json プレフィックスを使ってもよい。
   {
     "items": [
       { "id": "対象のopaque id", "topics": ["トピック1", "トピック2"] }
     ]
   }
2. **完全なID一致**: 入力されたすべての \`id\` について、出力の items に必ず含めること。入力の順序や件数をそのまま維持すること。
3. **トピックの仕様**:
   - 個数: 0〜4個（記事の具体性や情報量に応じて決定。素材が薄い場合は 0 個や 1 個でもよい）。
   - 形式: 短い名詞句（2〜10字）。文の断片、助詞・活用語尾で終わらないこと。
   - 禁止: 数字（半角・全角）、記号、URL、絵文字、句読点、個人識別情報（PII）、煽り表現。
    - 粒度: 単なる汎用フレーズ（例: "準備の進め方"）のみに頼らず、スライスが支持する範囲で内容・名詞・アングルを具体的に反映させること。ただしスライスが支持しない限り過度な補完を行わないこと（支持しない場合は abstain として空配列 [] を返してよい）。
    - 頻度上位回避: 現在DBで頻出の上位15語（演出/準備/演出の工夫/前撮り/家族婚/美容/DIY/神前式/会場選び/挙式演出/準備の進め方/ご祝儀/式場見学/撮影準備/見積もり）はスライスが明確に支持しない限り単独で生成しないこと。既に飽和しているため多様性を優先すること。
   - 外部補完・結論開示の禁止: スライス外の知識を勝手に補わないこと。記事の結論や結末をバラさないこと。

## 入力データ一覧
${JSON.stringify(itemsJson, null, 2)}`;
}
