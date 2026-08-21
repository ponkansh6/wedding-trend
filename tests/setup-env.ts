// テスト実行前に最低限の環境変数を設定する。
process.env.GOOGLE_API_KEY ??= "test-google-api-key";
process.env.TURSO_DATABASE_URL ??= ":memory:";
process.env.CRON_SECRET ??= "test-cron-secret";
