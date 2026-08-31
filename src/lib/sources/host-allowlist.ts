/**
 * discovery レーンで取得を許可するホストの allowlist（旧 src/lib/constants.ts より移設）。
 * 中身（ホスト・パターン・セレクタ・コメント）は移設時点から変更していない。
 */

// ── ホスト allowlist（plan 07 §6-Q3）────────────────────────
/**
 * discovery レーンで取得を許可するホストの allowlist。新規ホストの自動追加は
 * 禁止し、追加は明示的なコミットでのみ行う（アフィリエイトサイト等の混入を
 * 構造的に防ぐ）。既存の稼働ホスト（`src/lib/sources/sitemap-discovery.ts` /
 * `shared_plan/06-rationale-and-scraping.md` で検証済み）を列挙する。
 *
 * `tosUrl` は M3-K2（規約変更検知）が監視する規約ページの URL。自動発見は
 * しない（誤ったページを規約と誤認すると K2 が無意味なノイズを出し続ける
 * ため）。確証が持てないホストは `tosUrl: null` とし、確認でき次第埋める。
 */
export type AllowlistedHost = {
  readonly host: string;
  readonly tosUrl: string | null;
  /**
   * このホストで収集を許可する記事パス（pathname）のパターン。
   * いずれのパターンにも一致しない URL は取得しない（ホスト単位だけでなく
   * パス単位でもホワイトリスト方式を採る——ブラックリストはサイト側が
   * 新しい URL 構造を追加したときに静かに破れるため）。
   *
   * ホスト同様、**新規パターンの追加は明示的なコミットでのみ**行う。sitemap
   * の指定を変えるだけで未知のセクション（例: 口コミ投稿ページ）が収集対象に
   * 混入することを構造的に防ぐのが目的（shared_plan/06 §10「サイト単位での
   * 対象指定は採用しない——セクション＋パス接頭辞で定義する」）。
   */
  readonly articlePathPatterns: readonly RegExp[];
  /**
   * 記事本文コンテナを特定する CSS セレクタ（優先順）。実 HTML の構造ダンプで
   * 確定した「記事本体を囲む最小の要素」を先頭から試し、最初にマッチした
   * 要素の innerHTML を本文抽出の対象にする（`src/lib/sources/article-text.ts`
   * の `extractArticleContainer()`）。ページ全体を測るとナビ・フッター・
   * 第三者コンテンツ（口コミ等）が Q1 ゲートの指標に混入するため、
   * このセレクタでサブツリーを切り出してから指標を計算する。
   *
   * どのセレクタにも一致しない場合はテンプレート変更等による破損とみなし
   * `null` を返す（サイレントにページ全体へフォールバックしない）。
   */
  readonly articleContainerSelectors: readonly string[];
};
export const HOST_ALLOWLIST: readonly AllowlistedHost[] = [
  // www.mwed.jp: 規約 URL は実地調査で確認済み（HTTP 200、ページタイトル
  // 「みんなのウェディング サイト利用規約」、robots.txt 上 /kiyaku は
  // Disallow されていない）。
  //
  // articlePathPatterns: sitemap_stories.xml から実測で確認できた記事パスは
  // 次の2パターンのみ（`/story/cases/{id}/` と式場レビュー配下の
  // `/hall/{hallId}/rev/story/{id}/`）。同ホストには一般ユーザーの口コミ投稿
  // ページ `/hall/{hallId}/rev/{commentId}/`（`rev` の直後が `story` ではなく
  // 数値のコメント ID）も存在し、robots.txt では Disallow されていないため、
  // パスのホワイトリストが無いと sitemap の指定変更だけで UGC の口コミが
  // 混入する。両パターンは `rev` の直後のセグメントが固定リテラル `story`
  // かどうかで区別する（`hallId` / 末尾 ID 自体は数値が実測値だが、桁数や
  // 将来の英数字混在に対しても脆くならないよう `[^/]+` で受ける——区別に
  // 効いているのは ID の形ではなく `story` セグメントの有無）。
  {
    host: "www.mwed.jp",
    tosUrl: "https://www.mwed.jp/kiyaku",
    articlePathPatterns: [/^\/story\/cases\/[^/]+\/?$/, /^\/hall\/[^/]+\/rev\/story\/[^/]+\/?$/],
    // 実 HTML の構造ダンプで確定: div.story-detail が記事本体（見出し・
    // タイムライン・スタッフ紹介等）のみを含む最小コンテナ。口コミ・費用明細
    // （div#point-section-top）やサブナビ（nav.renewal-2023-place-menu）は
    // 兄弟ノードであり、このセレクタで自動的に除外される。
    // div.produce-story-detail はそのフォールバック（story-detail 自体が
    // テンプレート変更で消えた場合に一段広い範囲を試す）。
    articleContainerSelectors: ["div.story-detail", "div.produce-story-detail"],
  },
];
/** allowlist のホスト名のみを取り出した配列（ホスト判定用）。 */
export const HOST_ALLOWLIST_HOSTS: readonly string[] = HOST_ALLOWLIST.map((h) => h.host);
/** allowlist からホストの登録済み ToS URL を引く。未登録ホストや未設定は null。 */
export function getAllowlistedTosUrl(host: string): string | null {
  return HOST_ALLOWLIST.find((h) => h.host === host)?.tosUrl ?? null;
}

/**
 * URL がホスト allowlist かつ記事パスのホワイトリストの両方を満たすかを判定する。
 * ホストが allowlist に無い場合、またはパスがどのパターンにも一致しない場合は
 * false。URL のパースに失敗した場合も安全側で false。
 */
export function isAllowedArticleUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const entry = HOST_ALLOWLIST.find((h) => h.host === parsed.hostname);
  if (!entry) return false;
  return entry.articlePathPatterns.some((pattern) => pattern.test(parsed.pathname));
}
