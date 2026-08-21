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

const targets = [
  {
    id: "hatena-bookmark",
    name: "Hatena Bookmark",
    url: "https://b.hatena.ne.jp/hotentry/life.rss",
  },
  {
    id: "google-news",
    name: "Google News",
    url: "https://news.google.com/rss/search?q=%E7%B5%90%E5%A9%9A%E5%BC%8F&hl=ja&gl=JP&ceid=JP%3Aja",
  },
  { id: "note", name: "note", url: "https://note.com/hashtag/%E7%B5%90%E5%A9%9A%E5%BC%8F/rss" },
  {
    id: "ameblo",
    name: "Ameba Blog (Placeholder)",
    url: "https://blog.ameba.jp/",
    isPlaceholder: true,
  },
];

console.log(
  "ID".padEnd(20) + " | " + "Status".padEnd(8) + " | " + "Time (ms)".padEnd(10) + " | " + "Result",
);
console.log("-".repeat(65));

for (const t of targets) {
  if (t.isPlaceholder) {
    console.log(
      t.id.padEnd(20) +
        " | " +
        "N/A".padEnd(8) +
        " | " +
        "0".padEnd(10) +
        " | ⚠️ Placeholder (AMEBLO_BLOG_IDS is currently a placeholder returning 0 entries)",
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
