# 23. 原サイト確認に基づく記事固有トピックタグ化プラン

- 対象: `wedding-trend` の `topics` 生成・更新・保存・フィード表示
- 作成日: 2026-09-03
- 状態: **未着手**
- 参照: `openspec/specs/wedding-trend/spec.md` §5、§9.9、§10、§11、`shared_plan/18-ai-topic-tags.md`
- 最上位原則: 法務制約を緩めず、既存の厳格なアクセス規律の範囲で、内容訴求 `topics` の生成・更新時は当該実行中に原サイト本文を正規経路で確認する。DB の title、既存 excerpt、既存 topics だけから topics を更新してはならない。

---

## 1. 発端と撤回する前提

現在の内容タグ `topics` に「準備の進め方」「心構え」「確認ポイント」のような一般語が混じり、記事の中身を訴求できていない。`TrendTag`（`trend` / `classic`）と11分類の `category` は対象外であり、既存契約を維持する。

前版の「保存済み title + excerpt を優先し、タグ目的で原サイトを原則再取得しない」という前提は**撤回する**。短い抜粋だけで記事の中身を具体化すると、根拠のない補完や一般語化を避けられないためである。今後は、最大1,500字の judgment slice をメモリ上でのみ取り出し、入力として topics 専用生成を行う。ただし、全 published 投稿を無差別再取得してはならない。deterministic な generic 判定または legacy signature に該当する要修正候補だけを対象にし、既に specific な topics を持つ投稿は fetch しない。全件化オプションは設けない。

本文、container HTML、visible text、judgment slice はメモリ内だけに置き、LLM投入後に破棄する。DB、ログ、stdout、checkpoint、telemetry、例外、raw LLM request/response に保存・出力しない。`originalExcerpt` は常に `null` とする。本文を知っているように誤認させるタグ、入力にない固有名詞・出来事・評価・因果・数値の補完も禁止する。

## 2. 目標契約と現状経路

`topics` は、確認済みの原サイト本文から切り出した judgment slice が直接支持する、0〜4件の短い名詞句とする。対象、場面、選択軸、具体的特徴を表せるときだけ付与する。薄い入力、クリックベイト、一般助言だけの場合の `[]` または1件は正しい abstain であり、件数を埋める推測は禁止する。category や trend/classic は topics のフォールバックにしない。

現行の経路は `title + excerpt → src/lib/llm/schemas.ts / src/lib/llm/prompts.ts → src/lib/llm/batch.ts → src/lib/publish/gate.ts: validateTopics() → src/lib/db/ingest.ts: post_topics replace → src/lib/db/query.ts → src/components/feed/feed-card.tsx` である。`validateTopics()` は常に `ok` を返し、個別の不正値を除外・重複整理して最大4件へ整えるため、結果として空配列になり得る。

本変更では `curateBatch()` の結果から topics だけを拾わない。共通の Gemini / batch 基盤を再利用した topics 専用の `curateTopicsBatch()`、input schema、output schema を設ける。入力は opaque record id、逐語 title、メモリ上の slice、出力は同一 record id と `topics` だけとする。summary、category、`TrendTag`、tag、usefulness、topicAnchor、既存 `curationSignature` を生成・更新しない。record id の完全一致を必須とし、1 request の batch 上限は25件とする。batch 化は fetch の並列化を意味しない。

## 3. アクセス規律と状態遷移

RSS、evergreen、sitemap discovery を含む**全オンライン収集入口**で、topics の生成・更新時は原サイトを source-confirmed judgment slice で確認する。各入口の既存処理を実装前に調査し、共通の regulated fetch / extraction / topics-only service へ合流させる。title と feed excerpt だけから topics を更新する経路は残さない。`src/lib/pipeline/discovery-ingest.ts` の `disciplinedFetch(url, { purpose: "article" })` → container 抽出（`src/lib/sources/article-text.ts`）→ evidence gate → visible text → `selectJudgmentSlice()` は、その再利用可能な参照実装とする。

既存バックフィルの候補 selector は次の AND 条件に固定する: `published`、`blog`、現行 allowlist、許可 article path、generic 判定または legacy signature、同一 dedicated signature での成功履歴なし、retracted/deleted/blocked ではない。good specific candidate は fetch しない。

既存の `src/lib/sources/access-discipline.ts` を唯一のアクセス規律とし、以下をすべて維持する。

- `purpose: "article"`、robots の24時間キャッシュ、honest UA、conditional GET、512KB hard limit。
- ホストごとの sequential 実行（同一ホスト concurrency=1）。`Crawl-delay` と `MIN_HOST_INTERVAL_MS = 20秒` の大きい方を待つ。
- `DAILY_REQUEST_CAP_PER_HOST = 200`、K1〜K6 hard stop、B1 soft stop / UTC日次リセット、429 の `Retry-After`、ToS hash/change、allowlist を source of truth とする。
- host round-robin を用いて公平に予定する。daily cap の算入単位は、robots、ToS、article、redirect destination の再検証ごとに算入するかを Stage 0 の spec で具体的に固定する。未処理数や公開予定を理由に間隔・上限・gate を緩めない。

`spec.md` に旧80と200が混在する箇所があるため、実装 Stage 0 で実装値200へ整合する。ただし本計画作成時には spec 自体を編集しない。

| 状態                                                                                       | topics / LLM の扱い                                                                                                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| evidence不足、containerなし、titleなし、robots/ToS/allowlist拒否、hard stop、oversize、304 | topics不変。LLM禁止。content-free reason のみを監査許可フィールドに記録する。304を unconditional fetch へフォールバックしてはならない。    |
| 404 / 410                                                                                  | topics不変、LLM禁止。retraction workflow へ委譲する。                                                                                      |
| 429、fetch失敗、LLM/schema/DB失敗                                                          | topics、full signature、成功 signature を不変にする。retry は規律とresume状態に従う。                                                      |
| redirect                                                                                   | final URLを独立して allowlist、robots、ToS、rate で再検証する。cross-host も同様。canonical が別記事または同一性に疑義があれば no update。 |
| 成功                                                                                       | topics だけを原子的 replace し、成功後に限り dedicated signature を記録する。                                                              |

## 4. prompt、評価、最小ガード

`src/lib/llm/prompts.ts` に topics 専用規則と positive/negative few-shot を置く。「準備の進め方」のような単独一般句を、内容名詞＋具体的角度へ置換する。ただし一般語を全面禁止せず、slice がより具体化を支持しないときは abstain を選ぶ。入力外補完、結論開示、不支持固有名詞、数字、PII、同義反復は負例にする。`src/lib/llm/schemas.ts` は0〜4件、`src/lib/publish/gate.ts` は既存の文字数・名詞句・数字/記号/PII/固有名詞制約を適用する。`checkAnchorGrounding` を復活させない。

Stage 0 で100〜200件の評価セットを作る。11 category、入力の厚み、固有名詞、曖昧・クリックベイト・一般助言を層化する。golden には本文を保存せず、URL、hash、非内容 metadata だけを置く。評価時の都度 regulated fetch をするか、承認済みの短命 ephemeral fixture を使うかは spec decision とする。2名が groundedness、relevance、specificity、readability、non-duplication、abstention妥当性を独立評価する。

ベースライン後に generic rate、人手 grounded/relevance/specificity pass、missing（妥当abstain / 不当欠落を分離）、invalid、duplicate、件数分布、generation failure の閾値と比較手順を固定する。成功条件は groundedness 非悪化、generic の有意低下、不当欠落を許容内に置くこと。数値閾値はベースライン前に捏造しない。

shadow では同一の regulated input に現行/候補を offline 比較し、本番書込みをしない。観測後に必要なら、単独一般句の denylist と決定的な重複除去だけを追加する。controlled vocabulary、タグ階層、confidence 自己申告、検索UI、DB/UI大改修は非目標であり、必要性が測定された場合だけ別判断とする。

## 5. dedicated signature、保存、監査、ロールバック

既存 `curationSignature` は不変とする。topics 専用の `topicBackfillSignature` は `H/HMAC(recordId + normalized URL + sourceContentDigest + extractionVersion + topicPromptVersion + schemaVersion + modelId)` とする。sourceContentDigest を監査 metadata として許容するかは spec で決める。hash oracle のリスクがある場合は HMAC を使う。

同一 signature の成功だけを skip し、本文・prompt・schema・model・extractionの変化時だけ再判定する。失敗は topics、full signature、success signature を変えない。専用 metadata を `src/lib/db/schema.ts` と後方互換な `src/lib/db/migrations/` に置く案、既存 metadata を使う案を比較し、投稿単位の復元・監査要件を満たす方を Stage 0 で決める。

監査で許可するフィールドは run、record、source host/id、HTTP status、redirect classification、gate reason、bytes、timing、attempt、digest/signature/version、old/new topic count、outcome のみとする。本文・container・visible text・slice・excerpt・raw prompt/response・例外メッセージへの内容混入は禁止する。`assertNoSliceLeak` 相当の検査を success、failure、dry-run、debug、checkpoint、exception の全sinkに適用する。

rollback は run id 単位で行う。old topics journal が非内容 metadata として許容されるかを spec で決め、不可ならDB backupまたはtransaction historyを使う。どの経路でも本文を保存しない。

## 6. 実装段階と対象ファイル

### Stage 0: spec・decision・baseline

- `openspec/specs/wedding-trend/spec.md` の§5、§9.9、§10等を、0〜4/abstain、全オンライン入口でのsource-confirmed入力、topics-only更新、非永続化、アクセス規律へ同期し、200/旧80混在も200に整合する。**このspec更新の完了を実装着手gateとし、更新前はコード実装を開始しない。**
- selector、generic/legacy 定義、daily cap の算入単位（robots/ToS/article/redirect destination再検証ごと）、digest/HMAC を値として永続化するか、永続化しない場合の idempotency/resume 代替、metadata保存先、評価時fetch/ephemeral fixture、journal/rollbackを decision log で確定する。
- 新規候補 `tests/golden-set/topics/`、`scripts/ops/evaluate-topic-tags.mjs` を既存命名規約に合わせて設計する。

### Stage 1: 共通抽出の再利用と topics-only 評価

- `src/lib/sources/access-discipline.ts`、`src/lib/sources/article-text.ts`、`src/lib/pipeline/discovery-ingest.ts` を再利用し、新規候補 `src/lib/llm/topics-batch.ts` / `src/lib/llm/topics-schemas.ts` / `src/lib/llm/topics-prompts.ts` に topics-only 契約を分離する。
- `src/lib/llm/client.ts` の共通 Gemini 基盤を使い、25件以下の id完全一致 batch、prompt/schema/gate、shadow evaluationを実装する。

### Stage 2: selector、scheduler、監査、dry-run

- 新規候補 `scripts/ops/backfill-content-topics.mjs` と `scripts/lib/content-topic-backfill.mjs` を作る。既存 anchor backfill に混在させない。
- `--dry-run` は fetch + judge + validate を行い write=0、`--apply` は明示指定時だけ書く。limit/host、chunk、run id、checkpoint/resume、host fairness、stop/restart、全sink leak検査を備える。
- generic/unsupported/leak fixture を意図的に壊し、検証が実際に失敗することを確認する。

### Stage 3: 新規収集のロールアウト

- online shadow → 少量新規 → 全新規の順に進め、Stage 0 のmetrics gateを毎段階で満たすことを確認する。

### Stage 4: 限定バックフィル

- generic/legacy selectorだけを小さく適用し、metrics gate通過後に対象を拡大する。全件化は行わない。
- `src/lib/db/ingest.ts` の topics replace を利用またはtopics専用 transactionを追加し、非topicsフィールドを一切変更しない。

### Stage 5: rollback rehearsal と運用受入

- run id単位の停止、resume、rollback、監査データの非内容性、漏洩検査をリハーサルする。

対象候補: `src/lib/llm/prompts.ts`、`src/lib/llm/schemas.ts`、`src/lib/publish/gate.ts`、`src/lib/llm/client.ts`、`src/lib/constants.ts`、`src/lib/db/schema.ts`、`src/lib/db/ingest.ts`、`src/lib/db/migrations/`、`src/components/feed/feed-card.tsx`、`tests/topic-gate.test.ts`、`tests/llm-schemas.test.ts`、`tests/llm-batch.test.ts`、`tests/db.test.ts`、`tests/ui/feed-card.test.tsx`。UIは0/1/4タグ、折返し、空topicsでfallbackなし、逐語title・出典/著者・法務表示の維持だけを確認する。

## 7. 必須テストと Definition of Done

以下を unit / integration / operation test に分けて確認する。

- good specific candidate は fetch=0。generic candidate が200と全gateを通らなければ update=0。
- K1〜K6、B1、429、304、404/410、evidence不足、oversizeはLLM=0。redirect再検証、same-host concurrency=1、20秒/Crawl-delay、cap=200を確認する。
- opaque id mapping、partial malformed batch、0〜4/abstain、generic/unsupported/PII/数値/重複を確認する。
- 成功時に topics だけが変わる。batch delete → insert の insert失敗 integration test で旧topicsが保持され、他フィールドと失敗時のbyte列が不変であることを確認する。
- signature idempotency、dry-run/apply parity（dry-run write=0）、checkpoint/resume、run単位rollbackを確認する。
- success/failure/dry-run/debug/checkpoint/exception すべてのsinkで内容漏洩がない。意図的leak fixtureで実際にfailすることを示す。

Definition of Done:

- topics更新は正規アクセスで当該実行中に確認した本文sliceだけを根拠にし、既存DB情報だけで更新する経路がない。
- 全件再取得をせず、generic/legacy selector以外はfetch=0である。
- 本文由来データはメモリ外に漏れず、`originalExcerpt` はnullのままである。
- access discipline、status no-op、topics-only更新、dedicated signature、監査、rollbackが上記テストで確認できる。
- generic rateを下げつつgroundednessを悪化させず、abstainを不当欠落と区別できる。
- specを実装と同時更新し、本文非生成・非永続化、逐語title、出典/著者、アクセス規律を弱めない。

## 8. 残る spec decisions とリスク

1. `sourceContentDigest` / HMAC値を許可metadataとして永続化するか。永続化しない場合の idempotency/resume の代替を何にするか。
2. golden evaluationのregulated fetchと短命ephemeral fixtureの許容条件・保持期間。
3. robots、ToS、article、redirect destination再検証のそれぞれを daily cap にどう算入するか、host round-robinの公平性、checkpointに保存できる非内容状態。
4. topic metadataのDB migrationか既存metadataか、old topics journalの可否とrollback根拠。
5. generic/legacy selectorの決定的定義と、少量ロールアウトの対象・期間。

主なリスクは、原サイト確認が運用量を増やすこと、strict gateで更新が進まないこと、内容漏洩、digestのoracle化、モデル出力変動である。いずれも上限緩和や全件fetchでは解決せず、selectorの限定、no-op、HMAC判断、metrics gate、停止・rollbackで扱う。
