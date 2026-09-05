# 削除・維持台帳 (Removal Ledger)

Plan 18のPhase 5に備えた台帳であり、完了報告ではない。今回の実コード削除は **0件**。migration SQL・metadata・schema履歴は常に削除対象外である。

| Candidate                                    | Verdict | Reason                                                        |
| -------------------------------------------- | ------- | ------------------------------------------------------------- |
| `src/lib/pipeline/evergreen-via-pipeline.ts` | 維持    | `scripts/ops/submit-evergreen.mjs` の動的importから参照される |
| `src/lib/pipeline/evergreen-adapter.ts`      | 維持    | 現行pipelineで参照される                                      |
| `src/lib/pipeline/rss-adapter.ts`            | 維持    | RSS取得・統合処理で参照される                                 |
| pipeline / LLM主要export                     | 維持    | 実行経路またはテストからの参照が残る                          |
| migration SQL / metadata / schema            | 対象外  | DB履歴であり削除しない                                        |
| `TODO(plan10-I4)` / `@deprecated`            | 維持    | 他計画の範囲。Plan 18の削除根拠ではない                       |

未追跡のconfig/clock/DB port/stage/host concurrency scaffolding 10ファイルも、未配線のため削除・維持の確定対象にしていない。本コミットには含めない。

削除を行う前提は、参照数0の証拠、保持APIの確認、type-check/import検査、および一コミット単位でのrollbackである。次回見直しはpipeline縮小とscaffoldingの配線または除去判断の後に行う。
