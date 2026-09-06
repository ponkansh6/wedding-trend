/** M4: 客観トリガによる公開済み投稿の自動撤回。 */
import { bodyHashSimilarity, computeContainerBodyHash } from "./body-hash";
import { BODY_DRIFT_SIMILARITY_MIN } from "@/lib/constants";
import { HOST_ALLOWLIST_HOSTS } from "@/lib/sources/host-allowlist";
import {
  filterRemoved,
  getPostsByUrls,
  listPublishedForRevalidation,
  markRetracted,
  recordPublication,
} from "@/lib/db/repository";
import { computeContentHash } from "@/lib/llm/signature";
import { checkTermsOfServiceChange, disciplinedFetch } from "@/lib/sources/access-discipline";

/** 1回の再検証ランで確認する公開済み投稿数の上限。 */
const REVALIDATION_LIMIT = 20;

export interface RevalidationStats {
  checked: number;
  seeded: number;
  retractedSourceGone: number;
  retractedRobotsDisallowed: number;
  retractedTosChanged: number;
  retractedBodyChanged: number;
  containerNotFoundSkipped: number;
  ok: number;
}

function emptyRevalidationStats(): RevalidationStats {
  return {
    checked: 0,
    seeded: 0,
    retractedSourceGone: 0,
    retractedRobotsDisallowed: 0,
    retractedTosChanged: 0,
    retractedBodyChanged: 0,
    containerNotFoundSkipped: 0,
    ok: 0,
  };
}

/**
 * M4: 公開済み投稿の客観トリガによる自動撤回（plan 07 §5-M4）。
 *
 * 撤回は自動、復帰は人間。本文ハッシュの再検証は allowlist ホストに限り、
 * 404/410・robots・K2/K3 は全ホストに適用する。
 */
export async function revalidatePublishedPosts(opts?: {
  limit?: number;
}): Promise<RevalidationStats> {
  const limit = opts?.limit ?? REVALIDATION_LIMIT;
  const stats = emptyRevalidationStats();
  const now = new Date().toISOString();

  const candidates = await listPublishedForRevalidation(limit);
  if (candidates.length === 0) return stats;

  const removedIds = await filterRemoved(candidates.map((c) => c.id));

  for (const post of candidates) {
    if (!post.host) continue;
    if (removedIds.has(post.id)) continue;
    stats.checked++;

    const tosVerdict = await checkTermsOfServiceChange(post.host);
    if (tosVerdict && tosVerdict.kind === "kill_gate") {
      if (tosVerdict.gate === "K2" || tosVerdict.gate === "K3") {
        await markRetracted(post.id, "tos_changed", now);
        stats.retractedTosChanged++;
      }
      continue;
    }
    if (tosVerdict && tosVerdict.kind === "budget_exhausted") continue;

    const verdict = await disciplinedFetch(post.url, { purpose: "article" });
    switch (verdict.kind) {
      case "kill_gate": {
        if (verdict.gate === "K2" || verdict.gate === "K3") {
          await markRetracted(post.id, "tos_changed", now);
          stats.retractedTosChanged++;
        }
        continue;
      }
      case "budget_exhausted":
      case "retry_after":
        continue;
      case "blocked_robots": {
        await markRetracted(post.id, "robots_disallowed", now);
        stats.retractedRobotsDisallowed++;
        continue;
      }
      case "http_error": {
        if (verdict.status === 404 || verdict.status === 410) {
          await markRetracted(post.id, "source_gone", now);
          stats.retractedSourceGone++;
        }
        continue;
      }
      case "not_modified":
      case "too_large":
        stats.ok++;
        continue;
      case "ok":
        break;
    }

    if (!HOST_ALLOWLIST_HOSTS.includes(post.host)) {
      if (post.bodyHash == null || post.hashKind !== "surrogate") {
        const states = await getPostsByUrls([post.url]);
        const state = states.get(post.url);
        const seededPublishedAt = post.publishedAt ?? state?.createdAt ?? now;
        const surrogateHash =
          post.bodyHash ??
          computeContentHash(state?.originalTitle ?? "", state?.originalExcerpt ?? null);
        await recordPublication(post.id, seededPublishedAt, surrogateHash, "surrogate", 0, 0, 0);
        stats.seeded++;
        continue;
      }
      stats.ok++;
      continue;
    }

    const html = await verdict.response.text();
    const newHash = computeContainerBodyHash(html, post.host);
    if (newHash === null) {
      console.warn(`[discovery-ingest] revalidate container_not_found for post ${post.id}`);
      stats.containerNotFoundSkipped++;
      continue;
    }

    if (post.bodyHash == null) {
      const states = await getPostsByUrls([post.url]);
      const seededPublishedAt = states.get(post.url)?.createdAt ?? now;
      await recordPublication(post.id, seededPublishedAt, newHash, "body", 0, 0, 0);
      stats.seeded++;
      continue;
    }

    const similarity = bodyHashSimilarity(post.bodyHash, newHash);
    if (similarity < BODY_DRIFT_SIMILARITY_MIN) {
      await markRetracted(post.id, "body_changed", now);
      stats.retractedBodyChanged++;
      continue;
    }

    stats.ok++;
  }

  return stats;
}
