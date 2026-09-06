# Vitest Projects & Test Architecture

## 現行の責務

| Project / entry                  | Environment | Responsibility                        |
| -------------------------------- | ----------- | ------------------------------------- |
| root/node (`tests/**/*.test.ts`) | Node        | pipeline、DB、LLM、gate等の非UIテスト |
| UI (`tests/ui/**/*.test.tsx`)    | happy-dom   | React UIテストのみ                    |

`.ts` と `.tsx` およびpathを分離して二重収集を防ぐ。happy-domをUI project以外へ適用しない。DB integrationテストは実SQLite/LibSQL境界を扱い、unitテストは隔離されたstoreまたはmockを使う。

新しいprojectは、同一テスト集合で反復測定した短縮が確認できる場合にだけ追加する。DB巨大テストの分割、CI job並列化、changed detectionは未実装である。

## 警告方針

Vitest設定を明示ESM拡張子の `vitest.config.mts` に移行し、aliasの `__dirname` を `import.meta.dirname` に置換した。`package.json` の `type: module` 変更およびwarning抑止環境変数は使っていない。2026-09-06に直接 `pnpm exec vitest run tests/console-monitor.test.ts`（1 file / 4 tests）と実環境 `pnpm verify`（58 files / 617 passed / 1 skipped、coverage tiers・smoke・production schemaを含む）で、Vite config-loader warningが出ないことを確認した。

unexpected stderrの包括的なfail policyは未実装である。`console-monitor` のunit成功はprocess stderr gateの受入根拠にはせず、配線・negative・許容範囲はPlan 24 Slice 2で扱う。

`LibsqlError: no_such_table` はschema/migrationのresilience assertionで期待される場合があるが、無条件に抑止しない。各テストが意図を明示する。

## 現行値

- Historical pilot: 47 files / 578 passed / 1 skipped。
- 全working tree（scaffolding含む）の単発: 54 files / 605 passed / 1 skipped。
- コミット済みslice（scaffolding 10ファイルを一時除外）の単発: 49 files / 588 passed / 1 skipped。

いずれもproject分割による高速化を証明する反復値ではない。
