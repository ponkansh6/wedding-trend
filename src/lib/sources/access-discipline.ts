import { createHash } from "node:crypto";
import robotsParser from "robots-parser";
import {
  CRAWLER_USER_AGENT,
  DAILY_REQUEST_CAP_PER_HOST,
  getAllowlistedTosUrl,
  MAX_BODY_BYTES,
  MIN_HOST_INTERVAL_MS,
} from "@/lib/constants";
import {
  getHostGateState,
  getSourcePolicy,
  saveHostGateState,
  upsertSourcePolicy,
} from "@/lib/db/repository";
import type { HostGateState } from "@/lib/db/repository";

/**
 * アクセス規律レイヤー（plan 06 §5.4 / §9）。
 *
 * - 間隔: ホストあたり最低 5 秒。robots.txt の Crawl-delay があればその値を下限として尊重する
 * - 並列: ホスト内は逐次（最終リクエスト時刻で強制）。ホスト間のみ並列
 * - 総量: ホストあたり日次リクエスト予算（B1）。間隔だけでなく総量を見る。
 *   B1 は kill gate（K1〜K6・異常検知・人手解除要）とは性質が異なり、
 *   積み残しがある限り毎日発火するのが正常な定常状態（予算消化・UTC 日次自動リセット）。
 * - 条件付き GET: If-Modified-Since / ETag を送り、304 を扱う
 * - User-Agent: WeddingTrendBot/1.0（連絡先必須・UA 偽装禁止）
 * - robots.txt: 取得前に確認。キャッシュは 24 時間以内（RFC 9309 推奨）
 * - 429 / Retry-After: 指定値を厳密に守って 1 回だけ再開。24 時間内に 2 回目でホスト自動無効化
 *
 * kill gate の状態は `host_gate_state` テーブルに永続化する。`config` KV は
 * ISO 8601 カーソル専用（plan 06 §6）であるため、gate 識別子やストライク数と
 * いった非 ISO の状態値はこちらに置く。
 */

/** K1〜K6: 異常検知。`stateKind` を永続化し、人間の手動解除を要する（hard stop）。 */
export type KillGateId = "K1" | "K2" | "K3" | "K4" | "K5" | "K6";
/** B1: 予算消化。`stateKind` は書かず、UTC 日次で自動リセットされる（soft stop）。 */
export type BudgetGateId = "B1";

export type FetchVerdict =
  | { kind: "ok"; response: Response }
  | { kind: "not_modified" }
  | { kind: "blocked_robots" }
  | { kind: "kill_gate"; gate: KillGateId; detail: string }
  | { kind: "budget_exhausted"; gate: BudgetGateId; detail: string }
  | { kind: "retry_after"; retryAtISO: string }
  | { kind: "http_error"; status: number }
  | { kind: "too_large" };

export interface ConditionalHeaders {
  etag?: string | null;
  lastModified?: string | null;
}

export interface DisciplinedFetchOptions {
  conditional?: ConditionalHeaders;
  purpose: "robots" | "sitemap" | "article";
}

/**
 * RFC 9309 の推奨に従い、robots.txt のキャッシュは 24 時間以内。
 * 本番（GitHub Actions）はランごとに新規プロセスのため実質毎回取得だが、
 * 長寿命プロセスでも契約を守れるよう TTL を持たせる。テストから差し替え可能。
 */
let robotsCacheTtlMs = 24 * 60 * 60 * 1000;
/** robots.txt のグループ照合に使うプロダクトトークン（User-Agent 文字列の先頭語）。 */
const CRAWLER_TOKEN = "WeddingTrendBot";
/** Retry-After ヘッダが解釈できない場合の既定待機。 */
const DEFAULT_RETRY_AFTER_MS = 60_000;
/** K4 の cool-off 時間。 */
const K4_COOL_OFF_MS = 24 * 60 * 60 * 1000;
/** K6 の「24 時間内に 2 回目」判定窓。 */
const K6_WINDOW_MS = 24 * 60 * 60 * 1000;
/** K2 の規約チェック頻度上限（1 日 1 回）。テストから差し替え可能。 */
let k2CheckIntervalMs = 24 * 60 * 60 * 1000;

/**
 * 収集・自動アクセス・スクレイピング・複製利用に関する語彙（M3-K2）。
 * 単独では判定せず、同一文（区切り）内で禁止方向の語と共起した場合のみ
 * restrictive とみなす（低ノイズ化のための限定分類）。
 */
const TOS_ACCESS_TERMS_RE =
  /クロール|クローリング|スクレイピング|スクレイプ|自動(?:で|的に)?(?:収集|取得|アクセス)|ロボット|robot|crawl|scrape|複製|転載/i;
/** 禁止・不可・同意なし方向を示す語彙。 */
const TOS_PROHIBIT_TERMS_RE = /禁止|禁じ|許可なく|許諾なく|同意なく|お断り|不可/;

type RobotsParser = ReturnType<typeof robotsParser>;

// プロセス内キャッシュ（ホスト内逐次・robots 24h）。テストは __resetStateForTests で初期化する。
const robotsCache = new Map<string, { fetchedAtMs: number; parser: RobotsParser }>();
const lastRequestAt = new Map<string, number>();

let sleepImpl: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** テスト用: 待機処理を差し替える（実時間を待たずに間隔ロジックを検証する）。 */
export function __setSleepForTests(fn: (ms: number) => Promise<void>): void {
  sleepImpl = fn;
}

/**
 * テスト用: robots キャッシュの TTL を差し替える（K1 のハッシュ変化検知を
 * 同一プロセス内で検証するため。本番コードパスには影響しない）。
 */
export function __setRobotsCacheTtlForTests(ttlMs: number): void {
  robotsCacheTtlMs = ttlMs;
}

/**
 * テスト用: K2（規約変更検知）の 1 日 1 回チェック間隔を差し替える
 * （throttle を迂回して同一プロセス内で本番経路の fetch 発生を検証するため。
 * 本番コードパスの間隔自体は変えない）。
 */
export function __setK2CheckIntervalForTests(ms: number): void {
  k2CheckIntervalMs = ms;
}

/** 既定では実物の `getAllowlistedTosUrl`（`@/lib/constants`）を使う。テストからのみ差し替え可能。 */
let allowlistTosResolver: (host: string) => string | null = getAllowlistedTosUrl;

/**
 * テスト用: allowlist の tosUrl 解決関数を差し替える（実 `HOST_ALLOWLIST` に
 * 無いホストで本番経路 - `disciplinedFetch` → `ensureRobotsParser` →
 * `upsertSourcePolicy` - を通した検証を行うため）。`null` を渡すと既定の
 * `getAllowlistedTosUrl` に戻る。モジュール再読込（`vi.resetModules`）無しで
 * 静的 import のまま本番経路を検証できるようにするためのシーム。
 */
export function __setAllowlistTosResolverForTests(
  fn: ((host: string) => string | null) | null,
): void {
  allowlistTosResolver = fn ?? getAllowlistedTosUrl;
}

/** テスト用: プロセス内キャッシュ（robots / 最終リクエスト時刻 / TTL / K2 間隔 / allowlist resolver 差し替え）を初期化する。 */
export function __resetStateForTests(): void {
  robotsCache.clear();
  lastRequestAt.clear();
  robotsCacheTtlMs = 24 * 60 * 60 * 1000;
  k2CheckIntervalMs = 24 * 60 * 60 * 1000;
  allowlistTosResolver = getAllowlistedTosUrl;
}

function hostOf(url: string): string {
  return new URL(url).host;
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** DB に状態行が無い場合の初期状態（稼働中・カウンタ 0）。 */
function emptyGateState(host: string): HostGateState {
  return {
    host,
    gateId: null,
    stateKind: null,
    untilAt: null,
    k4Strikes: 0,
    last429At: null,
    countDay: "",
    countValue: 0,
  };
}

async function loadGateState(host: string): Promise<HostGateState> {
  return (await getHostGateState(host)) ?? emptyGateState(host);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parseRetryAfterMs(headerValue: string | null): number {
  if (!headerValue) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number.parseInt(headerValue, 10);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const atMs = Date.parse(headerValue);
  if (!Number.isNaN(atMs)) return Math.max(0, atMs - Date.now());
  return DEFAULT_RETRY_AFTER_MS;
}

/**
 * ホストの停止判別を型で分離する。soft/hard は判別可能なユニオンで表現し、
 * 呼び出し側（`disciplinedFetch`）は `kind` を読むだけで正しい `FetchVerdict`
 * を組み立てられるようにする（文字列比較で分岐させない）。
 */
interface HardHostBlock {
  kind: "hard";
  gate: KillGateId;
  detail: string;
}

interface SoftHostBlock {
  kind: "soft";
  gate: BudgetGateId;
  detail: string;
}

type HostBlock = HardHostBlock | SoftHostBlock;

/**
 * ホストの停止状態を確認する（ネットワーク I/O ゼロで拒否できる段階）。
 * K1〜K6 由来の hard stop のみを扱う。
 * - `"permanent"` / `"stopped"`: gate 識別子つきで即拒否（stopped は K1 由来の人手復帰待ち）
 * - `"cooloff"`: `untilAt` 経過までは拒否、経過後は自動再開
 */
async function getHostBlock(host: string): Promise<HardHostBlock | null> {
  const st = await loadGateState(host);
  if (st.stateKind === "permanent" || st.stateKind === "stopped") {
    return {
      kind: "hard",
      gate: (st.gateId ?? "K3") as KillGateId,
      detail: `host ${host} is ${st.stateKind} by ${st.gateId ?? "unknown gate"}`,
    };
  }
  if (st.stateKind === "cooloff" && st.untilAt) {
    const untilMs = Date.parse(st.untilAt);
    if (!Number.isNaN(untilMs) && Date.now() < untilMs) {
      return {
        kind: "hard",
        gate: (st.gateId ?? "K4") as KillGateId,
        detail: `host ${host} is cooling off until ${st.untilAt}`,
      };
    }
  }
  return null;
}

/**
 * B1: 日次リクエスト予算。差分巡回が壊れたときの事故形態（総量青天井）を防ぐ
 * ためのハードキャップだが、性質は K1〜K6 の異常検知とは異なる soft stop
 * （`stateKind` を書かず UTC 日次で自動リセット）。積み残しがある限り毎日
 * 発火するのが正常な定常状態であるため、B1 は決して kill gate 側に混ぜない。
 */
async function checkDailyCap(host: string): Promise<SoftHostBlock | null> {
  const st = await loadGateState(host);
  const count = st.countDay === todayUTC() ? st.countValue : 0;
  if (count >= DAILY_REQUEST_CAP_PER_HOST) {
    return {
      kind: "soft",
      gate: "B1",
      detail: `daily request budget exhausted for ${host}: ${count}/${DAILY_REQUEST_CAP_PER_HOST}`,
    };
  }
  return null;
}

async function bumpDailyCount(host: string): Promise<void> {
  const st = await loadGateState(host);
  const day = todayUTC();
  const next = st.countDay === day ? st.countValue + 1 : 1;
  await saveHostGateState({ ...st, countDay: day, countValue: next });
}

/** ホスト内逐次の間隔制御。同一ホストの直前リクエストから intervalMs 経過していない場合は待つ。 */
async function respectSpacing(host: string, intervalMs: number): Promise<void> {
  const last = lastRequestAt.get(host);
  if (last !== undefined) {
    const waitMs = intervalMs - (Date.now() - last);
    if (waitMs > 0) {
      await sleepImpl(waitMs);
    }
  }
  lastRequestAt.set(host, Date.now());
}

/**
 * 1 リクエストの実行と、ステータス → kill gate の写像。
 * 実際にリクエストした場合のみ日次カウントを消費する。
 */
async function performFetch(
  url: string,
  headers: Record<string, string>,
  purpose: "robots" | "sitemap" | "article",
): Promise<FetchVerdict> {
  const host = hostOf(url);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": CRAWLER_USER_AGENT,
        Accept:
          purpose === "article"
            ? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            : "text/plain,text/xml,application/xml,*/*;q=0.8",
        ...headers,
      },
      redirect: "follow",
    });
  } catch (err) {
    console.warn(`[access-discipline] fetch error url=${url}:`, err);
    return { kind: "http_error", status: 0 };
  }
  await bumpDailyCount(host);

  if (response.status === 401 || response.status === 451) {
    // K3: 明示的な拒否。即恒久停止、自動復帰なし。
    const st = await loadGateState(host);
    await saveHostGateState({ ...st, stateKind: "permanent", gateId: "K3" });
    return {
      kind: "kill_gate",
      gate: "K3",
      detail: `${response.status} on ${url} -> permanent disable`,
    };
  }
  if (response.status === 403) {
    if (purpose === "article") {
      // K4: cool-off 24h。連続 2 回で恒久無効化（WAF 起因の定常 403 で即恒久にしないため）。
      const st = await loadGateState(host);
      const strikes = st.k4Strikes + 1;
      if (strikes >= 2) {
        await saveHostGateState({
          ...st,
          k4Strikes: strikes,
          stateKind: "permanent",
          gateId: "K4",
        });
        return {
          kind: "kill_gate",
          gate: "K4",
          detail: `consecutive 403 x${strikes} on ${url} -> permanent disable`,
        };
      }
      const untilISO = new Date(Date.now() + K4_COOL_OFF_MS).toISOString();
      await saveHostGateState({
        ...st,
        k4Strikes: strikes,
        stateKind: "cooloff",
        gateId: "K4",
        untilAt: untilISO,
      });
      return {
        kind: "kill_gate",
        gate: "K4",
        detail: `403 on ${url} -> cool-off until ${untilISO}`,
      };
    }
    // K5: robots.txt / sitemap への 403 は配信の意思そのものへの拒否。
    // plan §9「K4 より重く」に従い、1 回で恒久停止とする。
    const st = await loadGateState(host);
    await saveHostGateState({ ...st, stateKind: "permanent", gateId: "K5" });
    return {
      kind: "kill_gate",
      gate: "K5",
      detail: `403 on ${purpose} fetch ${url} -> permanent disable`,
    };
  }
  if (response.status === 429) {
    // K6: Retry-After を厳密に守って 1 回だけ再開。24 時間内に 2 回目でホスト自動無効化。
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    const st = await loadGateState(host);
    const lastMs = st.last429At ? Date.parse(st.last429At) : Number.NaN;
    if (!Number.isNaN(lastMs) && Date.now() - lastMs < K6_WINDOW_MS) {
      await saveHostGateState({ ...st, stateKind: "permanent", gateId: "K6" });
      return {
        kind: "kill_gate",
        gate: "K6",
        detail: `second 429 within 24h on ${url} -> permanent disable`,
      };
    }
    await saveHostGateState({ ...st, last429At: new Date().toISOString() });
    return {
      kind: "retry_after",
      retryAtISO: new Date(Date.now() + retryAfterMs).toISOString(),
    };
  }
  if (response.status === 304) {
    return { kind: "not_modified" };
  }
  if (response.status >= 200 && response.status < 300) {
    // 取得サイズ上限（plan 06 §5.2）。相手のエラーではないため kill gate ではなく
    // 独立した verdict kind として扱う（呼び出し側で skipped/pending を判断する）。
    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader !== null) {
      const contentLength = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
        // content-length だけで超過が明白な場合は本文を読まずに打ち切る。
        return { kind: "too_large" };
      }
    } else {
      // content-length が無い（chunked 転送等）場合に備え、受信済み本文の
      // 実バイト長でも判定する。
      const body = await response.text();
      if (Buffer.byteLength(body, "utf-8") > MAX_BODY_BYTES) {
        return { kind: "too_large" };
      }
      // 本文は読み切ってしまっているため、呼び出し側がもう一度 .text() できる
      // よう読み取り済みテキストで新しい Response を作り直して返す。
      return { kind: "ok", response: new Response(body, { status: response.status }) };
    }
    return { kind: "ok", response };
  }
  return { kind: "http_error", status: response.status };
}

type RobotsResult = { ok: true; parser: RobotsParser } | { ok: false; verdict: FetchVerdict };

/**
 * robots.txt を取得・パースし、24 時間キャッシュする。
 * 内容ハッシュが source_policy から変化していれば K1 を発火させる。
 */
async function ensureRobotsParser(host: string): Promise<RobotsResult> {
  const cached = robotsCache.get(host);
  const now = Date.now();
  if (cached && now - cached.fetchedAtMs <= robotsCacheTtlMs) {
    return { ok: true, parser: cached.parser };
  }

  const robotsUrl = `https://${host}/robots.txt`;
  const verdict = await performFetch(robotsUrl, {}, "robots");
  if (verdict.kind !== "ok") {
    if (verdict.kind === "http_error" && verdict.status === 404) {
      // RFC 9309: 404 は全 URL 許可として扱う（空ルールのパーサ）。
      const parser = robotsParser(robotsUrl, "");
      robotsCache.set(host, { fetchedAtMs: now, parser });
      return { ok: true, parser };
    }
    return { ok: false, verdict };
  }

  const body = await verdict.response.text();
  const hash = sha256(body);

  // K1: robots.txt の内容ハッシュ変化。全ゲート中これが最も価値が高い。
  // 自動停止して人間の再確認を待つ（恒久無効化ではないため stateKind:"stopped"）。
  const policy = await getSourcePolicy(host);
  // allowlist（コミットされた明示的な設定）を真実の源とし、DB 側の古い
  // null を上書きして解決できるようにする。allowlist に未登録/tosUrl 未設定
  // の場合は既存の policy.tosUrl（あれば）をそのまま維持する。
  const resolvedTosUrl = allowlistTosResolver(host) ?? policy?.tosUrl ?? null;
  if (policy && policy.robotsHash !== hash) {
    // robots.txt のみの更新なので、既存の tosHash（M3-K2 の状態）は保持する。
    // tosUrl は allowlist 側の値へ解決する（上記 resolvedTosUrl）。
    await upsertSourcePolicy({
      host,
      robotsHash: hash,
      robotsBody: body,
      tosUrl: resolvedTosUrl,
      tosHash: policy.tosHash,
      checkedAt: new Date().toISOString(),
    });
    const st = await loadGateState(host);
    await saveHostGateState({ ...st, stateKind: "stopped", gateId: "K1" });
    return {
      ok: false,
      verdict: {
        kind: "kill_gate",
        gate: "K1",
        detail: `robots.txt hash changed for ${host}: ${policy.robotsHash.slice(0, 12)}… -> ${hash.slice(0, 12)}…`,
      },
    };
  }
  if (!policy) {
    // 初回観測: tosUrl は allowlist から解決する（登録が無ければ null。
    // K2 はここでは判断しない）。tosHash は常に null（次回 K2 チェックで
    // 初回観測として埋まる）。
    await upsertSourcePolicy({
      host,
      robotsHash: hash,
      robotsBody: body,
      tosUrl: resolvedTosUrl,
      tosHash: null,
      checkedAt: new Date().toISOString(),
    });
  } else if (policy.tosUrl !== resolvedTosUrl) {
    // robots ハッシュに変化は無いが、allowlist 側の tosUrl 設定が DB と
    // 食い違っている（例: 後から tosUrl を allowlist に追加した）場合は
    // ここで同期する。tosUrl が変わった以上、古い tosHash は無効なので
    // リセットし、次回 K2 チェックで初回観測として再ベースライン化する。
    await upsertSourcePolicy({
      host,
      robotsHash: policy.robotsHash,
      robotsBody: policy.robotsBody,
      tosUrl: resolvedTosUrl,
      tosHash: null,
      checkedAt: policy.checkedAt,
    });
  }

  const parser = robotsParser(robotsUrl, body);
  robotsCache.set(host, { fetchedAtMs: now, parser });
  return { ok: true, parser };
}

/**
 * アクセス規律に従って 1 URL を取得する。
 * 停止状態・日次キャップ・robots・ホスト内逐次・条件付き GET・kill gate をすべてここで扱う。
 */
export async function disciplinedFetch(
  url: string,
  opts?: DisciplinedFetchOptions,
): Promise<FetchVerdict> {
  const purpose = opts?.purpose ?? "article";
  const host = hostOf(url);

  // 1) 停止状態（K1/K3/K4/K5/K6 の結果）はネットワーク I/O ゼロで拒否。
  const block = await getHostBlock(host);
  if (block) {
    return { kind: "kill_gate", gate: block.gate, detail: block.detail };
  }

  // 2) B1: 日次リクエスト予算。robots 取得より先に拒否できる。
  const capBlock = await checkDailyCap(host);
  if (capBlock) {
    return { kind: "budget_exhausted", gate: capBlock.gate, detail: capBlock.detail };
  }

  // 3) robots.txt の確認（purpose:"robots" の取得自身は対象外）。
  let crawlDelaySec: number | null = null;
  if (purpose !== "robots") {
    const robots = await ensureRobotsParser(host);
    if (!robots.ok) {
      return robots.verdict;
    }
    const allowed = robots.parser.isAllowed(url, CRAWLER_TOKEN);
    if (allowed === false) {
      return { kind: "blocked_robots" };
    }
    const delay = robots.parser.getCrawlDelay(CRAWLER_TOKEN) ?? robots.parser.getCrawlDelay("*");
    if (delay !== undefined && delay > 0) {
      crawlDelaySec = delay;
    }
    // robots 取得でも日次カウントを消費しているため、本取得の前に境界を再確認する。
    const capRecheck = await checkDailyCap(host);
    if (capRecheck) {
      return { kind: "budget_exhausted", gate: capRecheck.gate, detail: capRecheck.detail };
    }
  }

  // 4) ホスト内逐次の間隔制御（最低 5 秒、Crawl-delay が大きければそちらを下限）。
  const intervalMs = Math.max(MIN_HOST_INTERVAL_MS, (crawlDelaySec ?? 0) * 1000);
  await respectSpacing(host, intervalMs);

  // 5) 条件付き GET。304 は相手のコストをほぼゼロにする礼儀と効率が一致する箇所。
  const headers: Record<string, string> = {};
  if (opts?.conditional?.etag) {
    headers["If-None-Match"] = opts.conditional.etag;
  }
  if (opts?.conditional?.lastModified) {
    headers["If-Modified-Since"] = opts.conditional.lastModified;
  }

  return performFetch(url, headers, purpose);
}

// ── M3-K2: 規約変更検知 ──────────────────────────────────────────

export type TosChangeClassification = "unchanged" | "benign_change" | "restrictive_change";

/**
 * 規約ページ HTML を正規化テキストに変換する（M3-K2）。
 * script/style/noscript を除去 → タグ除去 → 空白正規化 → 小文字化。
 * 広告・トークン等で毎回変わる生 HTML のノイズを吸収するために必須の前処理。
 * 文区切り（句点・改行）は判定のため保持する。
 */
export function normalizeTosText(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const withoutTags = withoutNoise.replace(/<[^>]+>/g, " ");
  return withoutTags
    .replace(/[ \t\f\v ]+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * 正規化済み規約テキストを限定分類する（M3-K2）。
 * 収集・自動アクセス・スクレイピングに関する語が、禁止方向の語と
 * 「同一文」内で共起する場合のみ restrictive_change とする。
 * 単独出現（例: 無関係な文脈での「禁止」）では反応させないための限定分類。
 *
 * 注意: source_policy は変更前の規約本文までは保持しない（tos_hash のみ）ため、
 * ここでの「差分」は「ハッシュが変化した際の、変化後テキスト中の restrictive
 * パターンの有無」で近似する。真の差分（新規出現かどうか）までは検知できないが、
 * plan 07 §5-M3 が許容するフォールバック（低ノイズ化できない場合は「監視していた」
 * という記録自体に価値を置く）に沿う。
 */
export function classifyTosChange(normalizedText: string): TosChangeClassification {
  const segments = normalizedText.split(/[。.\n]+/);
  for (const seg of segments) {
    if (TOS_ACCESS_TERMS_RE.test(seg) && TOS_PROHIBIT_TERMS_RE.test(seg)) {
      return "restrictive_change";
    }
  }
  return "benign_change";
}

/**
 * 規約ページの変更を検知する（M3-K2）。1 ホストにつき 1 日 1 回を上限とする。
 * - `source_policy.tosUrl` が未設定のホストは対象外（null を返す）
 * - 取得失敗時は fail-closed（K2 でホスト停止、kill_gate を返す）
 * - restrictive_change 検知時も fail-closed（K1 と同様 "stopped" = 人手復帰待ち）
 * - unchanged / benign_change / 初回観測時は non-blocking（null）で source_policy を更新
 *
 * **既知の許容トレードオフ: `checked_at` を robots チェックと共有している。**
 * `source_policy` は `checked_at` 列を 1 本しか持たず、robots 側
 * （`ensureRobotsParser` の初回観測・robots ハッシュ変化時）と K2 側
 * （本関数の unchanged / benign_change / 初回観測時）が同じ列を書く。
 * K2 はこの列を「前回の規約チェック時刻」として 24 時間 throttle の起点に
 * 読むため、robots.txt が変化した直後は規約チェックが最大 1 日先送りされる
 * （robots 側の更新が `checked_at` を進めてしまうため）片方向の結合がある。
 * マイグレーションが追加専用（`ALTER TABLE` 禁止）のため列を追加できず、
 * 別テーブルへ分離すると `tos_hash` が休眠列化しかねない（plan 07 §5-M3 の
 * 禁止事項）ため、この遅延は許容する。
 */
export async function checkTermsOfServiceChange(host: string): Promise<FetchVerdict | null> {
  const policy = await getSourcePolicy(host);
  if (!policy || !policy.tosUrl) {
    return null;
  }

  const lastCheckedMs = Date.parse(policy.checkedAt);
  if (!Number.isNaN(lastCheckedMs) && Date.now() - lastCheckedMs < k2CheckIntervalMs) {
    return null;
  }

  const tosUrl = policy.tosUrl;
  const verdict = await disciplinedFetch(tosUrl, { purpose: "article" });

  if (verdict.kind !== "ok") {
    // 既に別ゲートで停止済み（hard）や日次予算消化（soft）ならその detail を
    // そのまま伝播する。B1 は異常ではないため、ここで K2（hard・人手解除要）
    // に格上げしてはならない。
    if (verdict.kind === "kill_gate" || verdict.kind === "budget_exhausted") {
      return verdict;
    }
    // 取得自体の失敗は fail-closed（無検証で走り続けない）。
    const st = await loadGateState(host);
    await saveHostGateState({ ...st, stateKind: "stopped", gateId: "K2" });
    return {
      kind: "kill_gate",
      gate: "K2",
      detail: `ToS fetch failed for ${host} (verdict=${verdict.kind}) -> stopped (fail-closed)`,
    };
  }

  const html = await verdict.response.text();
  const normalized = normalizeTosText(html);
  const hash = sha256(normalized);
  const checkedAt = new Date().toISOString();

  if (!policy.tosHash) {
    // 初回観測: ベースラインとして保存するのみ。ブロックしない。
    await upsertSourcePolicy({
      host,
      robotsHash: policy.robotsHash,
      robotsBody: policy.robotsBody,
      tosUrl,
      tosHash: hash,
      checkedAt,
    });
    return null;
  }

  if (policy.tosHash === hash) {
    // unchanged: checked_at のみ更新（1 日 1 回キャップの起点を進める）。
    await upsertSourcePolicy({
      host,
      robotsHash: policy.robotsHash,
      robotsBody: policy.robotsBody,
      tosUrl,
      tosHash: hash,
      checkedAt,
    });
    return null;
  }

  const classification = classifyTosChange(normalized);
  await upsertSourcePolicy({
    host,
    robotsHash: policy.robotsHash,
    robotsBody: policy.robotsBody,
    tosUrl,
    tosHash: hash,
    checkedAt,
  });

  if (classification === "restrictive_change") {
    const st = await loadGateState(host);
    await saveHostGateState({ ...st, stateKind: "stopped", gateId: "K2" });
    return {
      kind: "kill_gate",
      gate: "K2",
      detail: `ToS restrictive change detected for ${host}: ${policy.tosHash.slice(0, 12)}… -> ${hash.slice(0, 12)}…`,
    };
  }

  // benign_change: non-blocking. ハッシュ更新のみ（既に upsert 済み）。
  return null;
}
