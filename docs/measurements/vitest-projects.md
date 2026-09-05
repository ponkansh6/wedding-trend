# Vitest Projects & Test Architecture

## 現行の責務

| Project / entry                  | Environment | Responsibility                        |
| -------------------------------- | ----------- | ------------------------------------- |
| root/node (`tests/**/*.test.ts`) | Node        | pipeline、DB、LLM、gate等の非UIテスト |
| UI (`tests/ui/**/*.test.tsx`)    | happy-dom   | React UIテストのみ                    |

`.ts` と `.tsx` およびpathを分離して二重収集を防ぐ。happy-domをUI project以外へ適用しない。DB integrationテストは実SQLite/LibSQL境界を扱い、unitテストは隔離されたstoreまたはmockを使う。

新しいprojectは、同一テスト集合で反復測定した短縮が確認できる場合にだけ追加する。DB巨大テストの分割、CI job並列化、changed detectionは未実装である。

## 警告方針

`pnpm test` は既知のVite config-loader warningをpolicy経路で抑止する。これは出力ノイズの制御であり、Viteの根本解消ではない。直接 `pnpm exec vitest` では当該warningが残るため、unexpected stderrの包括的なfail policyは未実装である。

`LibsqlError: no_such_table` はschema/migrationのresilience assertionで期待される場合があるが、無条件に抑止しない。各テストが意図を明示する。

## 現行値

- Historical pilot: 47 files / 578 passed / 1 skipped。
- 全working tree（scaffolding含む）の単発: 54 files / 605 passed / 1 skipped。
- コミット済みslice（scaffolding 10ファイルを一時除外）の単発: 49 files / 588 passed / 1 skipped。

いずれもproject分割による高速化を証明する反復値ではない。
