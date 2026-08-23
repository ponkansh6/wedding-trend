import { curatePosts } from "../src/lib/llm/batch.ts";

const SAMPLE_URLS = [
  // Post-contract preparation, item selection, budget tradeoff items
  {
    url: "https://zexy.net/article/CCn020/20231201/",
    title: "【結婚式のお金】見積りから最終金額はどう変わる？リアルな増減理由と節約のコツ",
    excerpt:
      "契約後の初期見積もりからの上がり幅や、ドレス・装花などのリアルな追加費用、削るべきポイントと妥協してはいけないポイントの体験談。",
  },
  {
    url: "https://zexy.net/article/CCn050/20240215/",
    title: "料理・ドリンクのランクアップでゲストの満足度はどう変わる？先輩カップルの選択",
    excerpt:
      "試食会を経て決定した料理のコース変更。予算との兼ね合いでどのランクを選び、どこを削ったかという具体的な意思決定の記録。",
  },
  {
    url: "https://www.mwed.jp/articles/12345/",
    title: "持ち込み料を払ってでも外部ドレスを選ぶべき？メリット・デメリットと実際の総額",
    excerpt:
      "提携ショップ以外のドレスを持ち込む際の交渉や、持ち込み料を相殺しても安くなったケースなどのリアルなコスト比較。",
  },
  {
    url: "https://www.minnanowedding.jp/articles/67890/",
    title: "招待状のWeb化 vs 紙の招待状：ゲスト層に合わせてどう判断した？",
    excerpt:
      "準備期間中のペーパーアイテム削減とゲストへの配慮。コスト削減効果と年配ゲストへの対応に関する意思決定。",
  },
  {
    url: "https://zexy.net/article/CCn080/20240410/",
    title: "席次表・席札を手作りしてどれくらい節約できた？トラブルと作業負担の本音",
    excerpt:
      "式場に頼まず自作を選んだことで生じた労力と、費用の差額についての体験談。当事者によるリアルなトレードオフ。",
  },
  {
    url: "https://www.mwed.jp/articles/23456/",
    title: "引き出物の贈り分けは本当に面倒？ゲスト満足度を上げた実際の品物選び",
    excerpt:
      "親族・上司・友人での贈り分けを決定した理由と、品物選びにおける予算配分の意思決定プロセス。",
  },
  {
    url: "https://www.mwed.jp/articles/34567/",
    title: "装花を減らしても寂しくならない？クロスの色と照明で魅せるコストダウン術",
    excerpt:
      "高砂やゲストテーブルのフラワーボリュームを抑える代わりに、クロスやキャンドルで空間を演出した具体的な工夫。",
  },
  {
    url: "https://zexy.net/article/CCn090/20240520/",
    title: "ムービー自作のリアル：外注費を浮かせた代わりのスケジュール地獄と家族の反応",
    excerpt:
      "プロフィールムービーやオープニングムービーを自作した際の制作期間、ソフト選び、家族からのフィードバック。",
  },
  {
    url: "https://www.minnanowedding.jp/articles/78901/",
    title: "司会者を外部の友人やフリーランスに依頼した際の交渉と当日のトラブル防止策",
    excerpt:
      "式場専属ではなく外部司会者を起業して持ち込んだ際の持込料や、事前の打ち合わせにおける注意点。",
  },
  {
    url: "https://zexy.net/article/CCn100/20240601/",
    title: "ドレスのインナーや小物レンタルをメルカリやフリマアプリで揃えて起きた誤算",
    excerpt:
      "費用を抑えるためにフリマアプリを活用したものの、サイズ調整や色味の違いで苦労したリアルな失敗談。",
  },
  {
    url: "https://www.mwed.jp/articles/45678/",
    title: "お色直しのドレス1着に絞って演出に予算を回した結果、ゲストの反応はどうだったか",
    excerpt:
      "2着から1着に減らしたことで生まれた余剰予算を、デザートビュッフェや演出に振り分けた意思決定の記録。",
  },
  {
    url: "https://www.minnanowedding.jp/articles/89012/",
    title: "親族控室のドリンクやおもてなし：削っても問題なかった費用・残すべき費用",
    excerpt:
      "細かいオプション項目の取捨選択。当日親族からどう見られるかを考慮したリアルなコストカットの判断。",
  },
  {
    url: "https://zexy.net/article/CCn110/20240705/",
    title: "カメラマンの持ち込み禁止式場でどう交渉した？アルバム代を抑える裏技",
    excerpt:
      "式場指定のカメラマンが高額なため、持ち込み交渉を行った経緯と、撮影データの納品に関する条件交渉の実際。",
  },
  {
    url: "https://www.mwed.jp/articles/56789/",
    title: "ウェルカムスペースのグッズを100均でDIY：安っぽく見せないための配置の極意",
    subdirectory: "",
    excerpt:
      "予算をかけずにオリジナリティを出すための100円ショップアイテムの活用法と、当事者による手作りの工夫。",
  },
  {
    url: "https://www.minnanowedding.jp/articles/90123/",
    title: "両親への記念品贈呈：定番の花束をやめて実用的な記念品を選んだ理由と家族の感想",
    excerpt:
      "ウェイトベアや時計、旅行券など、花束以外の記念品を選択した際の親世代の反応と予算の兼ね合い。",
  },
  {
    url: "https://zexy.net/article/CCn120/20240812/",
    title: "お車代の渡し方と遠方ゲストへの配慮：赤字を出さないための事前のルール決め",
    excerpt:
      "交通費の全額負担が難しい場合の折半交渉や、当日スムーズに渡すための封筒準備などの実務的な判断。",
  },
  {
    url: "https://www.mwed.jp/articles/67890/",
    title: "二次会を幹事代行業者に頼んだメリット・デメリット：自力運営との費用対効果",
    excerpt:
      "友人への負担を減らすために代行業者を入れた場合の費用内訳と、運営のクオリティについてのリアルな評価。",
  },
  {
    url: "https://www.minnanowedding.jp/articles/11223/",
    title: "引菓子の重さと持ち帰りやすさを考慮したブランド選び：ゲストのリアルな声",
    excerpt:
      "定番のバウムクーヘンから焼き菓子セットに変更した理由と、ゲストへの配慮としてのサイズ・重さのトレードオフ。",
  },
  {
    url: "https://zexy.net/article/CCn130/20240901/",
    title: "プロフィールブックを手作りして席次表と一体化したコストカットと情報の工夫",
    excerpt:
      "ペーパーアイテムを一冊にまとめることで印刷費とデザイン料を削減した具体的なプロセスと構成案。",
  },
  {
    url: "https://www.mwed.jp/articles/78901/",
    title: "ブーケの生花をドライフラワー保存加工して残した費用対効果と仕上がりの満足度",
    excerpt:
      "式後にブーケを加工保存するための高額な費用対効果について、当事者が下した判断と現在の感想。",
  },
];

async function runValidation() {
  console.log(`[validator] Starting evergreen validation with ${SAMPLE_URLS.length} items...`);

  const inputs = SAMPLE_URLS.map((item) => ({
    title: item.title,
    excerpt: item.excerpt,
  }));

  const startTime = Date.now();
  const { results, geminiCalls } = await curatePosts(inputs);
  const duration = Date.now() - startTime;

  let passedCount = 0;
  let totalEvaluated = 0;

  results.forEach((res, idx) => {
    const item = SAMPLE_URLS[idx];
    console.log(`\n--- Item ${idx + 1}: ${item.title} ---`);
    if (!res) {
      console.log(`Result: FAILED / NULL (LLM error or deadline exceeded)`);
      return;
    }
    totalEvaluated++;
    const passes = res.ceremonyDecision && !res.preDecisionOrPhotoShoot;
    if (passes) {
      passedCount++;
    }
    console.log(`Category: ${res.category} | Tag: ${res.tag}`);
    console.log(
      `Firsthand: ${res.firsthand} | Specific: ${res.specific} | Tradeoff: ${res.tradeoff}`,
    );
    console.log(
      `CeremonyDecision: ${res.ceremonyDecision} | PreDecisionOrPhotoShoot: ${res.preDecisionOrPhotoShoot}`,
    );
    console.log(`Passes Gate: ${passes ? "✅ PASS" : "❌ FAIL"}`);
    console.log(`Summary: ${res.summary}`);
  });

  const passRate = totalEvaluated > 0 ? (passedCount / SAMPLE_URLS.length) * 100 : 0;

  console.log(`\n========================================`);
  console.log(`VALIDATION SUMMARY:`);
  console.log(`Total Items: ${SAMPLE_URLS.length}`);
  console.log(`Successfully Evaluated: ${totalEvaluated}`);
  console.log(`Passed Gate: ${passedCount}`);
  console.log(`Pass Rate: ${passRate.toFixed(1)}% (Target: >= 30%)`);
  console.log(`Gemini API Calls: ${geminiCalls}`);
  console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);
  console.log(`========================================`);

  if (passRate >= 30) {
    console.log(`🎉 SUCCESS: Evergreen validation achieved target pass rate (>=30%)!`);
  } else {
    console.log(`⚠️ WARNING: Pass rate is below 30%. Review prompt or sample set.`);
  }
}

runValidation().catch((err) => {
  console.error("[validator] Fatal error:", err);
  process.exit(1);
});
