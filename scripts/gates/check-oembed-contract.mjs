import https from "https";

async function checkOEmbed(provider, url) {
  let endpoint = "";
  const encoded = encodeURIComponent(url);
  if (provider === "instagram") {
    endpoint = `https://graph.facebook.com/v25.0/instagram_oembed?url=${encoded}&omitscript=true`;
  } else if (provider === "tiktok") {
    endpoint = `https://www.tiktok.com/oembed?url=${encoded}`;
  } else if (provider === "youtube") {
    endpoint = `https://www.youtube.com/oembed?url=${encoded}&format=json`;
  } else {
    return { ok: false, error: "Unknown provider" };
  }

  return new Promise((resolve) => {
    const start = Date.now();
    const req = https.get(
      endpoint,
      { headers: { "User-Agent": "WeddingTrendMonitor/1.0" } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          const responseTime = Date.now() - start;
          if (res.statusCode !== 200) {
            resolve({
              ok: false,
              status: res.statusCode,
              responseTime,
              error: `HTTP status ${res.statusCode}`,
            });
            return;
          }
          try {
            const json = JSON.parse(data);
            const hasHtml = typeof json.html === "string" && json.html.length > 0;
            // Instagram の blockquote 応答は thumbnail_url を含まない仕様のため対象外。
            // YouTube / TikTok は返すことが契約なので、欠落を検知する。
            const thumbRequired = provider === "youtube" || provider === "tiktok";
            const hasThumb =
              typeof json.thumbnail_url === "string" && json.thumbnail_url.length > 0;

            if (!hasHtml) {
              resolve({
                ok: false,
                status: res.statusCode,
                responseTime,
                error: "Missing 'html' in response",
              });
            } else if (thumbRequired && !hasThumb) {
              resolve({
                ok: false,
                status: res.statusCode,
                responseTime,
                error: "Missing 'thumbnail_url' in response",
              });
            } else {
              resolve({ ok: true, status: res.statusCode, responseTime });
            }
          } catch {
            resolve({
              ok: false,
              status: res.statusCode,
              responseTime,
              error: "Invalid JSON response",
            });
          }
        });
      },
    );

    req.on("error", (err) => {
      resolve({ ok: false, status: 0, responseTime: Date.now() - start, error: err.message });
    });

    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ ok: false, status: 0, responseTime: Date.now() - start, error: "Request timeout" });
    });
  });
}

console.log("==================================================");
console.log("  Wedding Trend - oEmbed Contract Monitor");
console.log("==================================================");

// Representative public URLs for contract testing
const testCases = [
  { provider: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
  { provider: "tiktok", url: "https://www.tiktok.com/@scout2015/video/6718335390845095173" },
  // 実在する公開投稿を使う。存在しないダミー URL では Graph API が常に
  // "Media Not Found"(400) を返し、契約は一切検証されない。
  { provider: "instagram", url: "https://www.instagram.com/p/CUbHfhpswxt/" },
];

let hasFailure = false;

console.log(
  "Provider".padEnd(12) +
    " | " +
    "Status".padEnd(8) +
    " | " +
    "Time (ms)".padEnd(10) +
    " | " +
    "Contract Result",
);
console.log("-".repeat(60));

for (const tc of testCases) {
  const result = await checkOEmbed(tc.provider, tc.url);
  const statusStr = result.status ? String(result.status) : "ERR";
  const okStr = result.ok ? "✅ PASS" : `❌ FAIL (${result.error})`;

  // Instagram も含め全プロバイダを失敗判定の対象にする。
  // Instagram はキーレス oEmbed の仕様変更履歴があり最も壊れやすいため、
  // ここを除外すると監視の意味が失われる。
  if (!result.ok) {
    hasFailure = true;
  }

  console.log(
    tc.provider.padEnd(12) +
      " | " +
      statusStr.padEnd(8) +
      " | " +
      String(result.responseTime).padEnd(10) +
      " | " +
      okStr,
  );
}

console.log("==================================================");
if (hasFailure) {
  console.error("❌ oEmbed contract check failed for critical providers.");
  process.exit(1);
} else {
  console.log("✅ oEmbed contract checks completed.");
  process.exit(0);
}
