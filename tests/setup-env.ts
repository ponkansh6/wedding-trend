// テスト実行前に最低限の環境変数を設定する。
// 実ネットワークには一切アクセスしないため値はダミーで良い。
process.env.GOOGLE_API_KEY ??= "test-google-api-key";
process.env.TURSO_DATABASE_URL ??= ":memory:";
process.env.CRON_SECRET ??= "test-cron-secret";
