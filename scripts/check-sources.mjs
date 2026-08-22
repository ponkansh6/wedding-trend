import https from "https";
import http from "http";

async function fetchUrl(url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { headers: { "User-Agent": "WeddingTrendMonitor/1.0" } }, (res) => {
      let length = 0;
      res.on("data", (chunk) => {
        length += chunk.length;
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
          responseTimeMs: Date.now() - start,
          bodyLength: length,
        });
      });
    });

    req.on("error", () => {
      resolve({
        status: 0,
        ok: false,
        responseTimeMs: Date.now() - start,
        bodyLength: 0,
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({
        status: 0,
        ok: false,
        responseTimeMs: Date.now() - start,
        bodyLength: 0,
      });
    });
  });
}

console.log("==================================================");
console.log("  Wedding Trend - Source Supply-Line Monitor");
console.log("==================================================");

let hasError = false;

// NOTE: ここで叩く URL は、アダプタが実際に使う URL と同じ形にしておくこと。
// 別の URL を監視していると「監視は緑なのに本番は死んでいる」状態になる。
const targets = [
  {
    id: "google-news",
    name: "Google News",
    url: "https://news.google.com/rss/search?q=%E7%B5%90%E5%A9%9A%E5%BC%8F&hl=ja&gl=JP&ceid=JP%3Aja",
  },
  { id: "note", name: "note", url: "https://note.com/hashtag/%E7%B5%90%E5%A9%9A%E5%BC%8F/rss" },
  {
    id: "hatena-bookmark",
    name: "Hatena Bookmark",
    url: "https://b.hatena.ne.jp/search/tag?q=%E7%B5%90%E5%A9%9A%E5%BC%8F&mode=rss&sort=recent",
    disabledReason: "HATENA_BOOKMARK_TAGS が空。内容が議論・炎上寄りのため一旦停止中",
  },
  {
    id: "ameblo",
    name: "Ameba Blog",
    url: "https://rssblog.ameba.jp/staff/rss.html",
    disabledReason: "AMEBLO_BLOG_IDS が空。ジャンル経由の候補は内容が卒花レポではないため未採用",
  },
];

console.log(
  "ID".padEnd(20) + " | " + "Status".padEnd(8) + " | " + "Time (ms)".padEnd(10) + " | " + "Result",
);
console.log("-".repeat(65));

for (const t of targets) {
  // 意図的に停止中のソースは死活判定の対象外にする（落として赤くしない）。
  if (t.disabledReason) {
    console.log(
      t.id.padEnd(20) +
        " | " +
        "N/A".padEnd(8) +
        " | " +
        "0".padEnd(10) +
        ` | ⏸️  無効化中 (${t.disabledReason})`,
    );
    continue;
  }

  const res = await fetchUrl(t.url);
  const statusStr = res.status ? String(res.status) : "ERR";
  const okStr = res.ok ? "✅ OK" : "❌ DEAD/FAIL";
  if (!res.ok) {
    hasError = true;
  }

  console.log(
    t.id.padEnd(20) +
      " | " +
      statusStr.padEnd(8) +
      " | " +
      String(res.responseTimeMs).padEnd(10) +
      " | " +
      okStr,
  );
}

console.log("==================================================");
if (hasError) {
  console.error("❌ Some feed sources are unreachable or returning errors.");
  process.exit(1);
} else {
  console.log("✅ All active feed sources are reachable.");
  process.exit(0);
}
