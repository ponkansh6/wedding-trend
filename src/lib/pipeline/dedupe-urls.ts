import type { PipelineCandidate } from "./run-pipeline";
import { canonicalizeUrl } from "@/lib/url";

/**
 * Deduplicate candidates by their canonical URL, keeping the first occurrence order.
 */
export function dedupeUrls(rawCandidates: PipelineCandidate[]): PipelineCandidate[] {
  const seen = new Set<string>();
  const deduped: PipelineCandidate[] = [];
  for (const c of rawCandidates) {
    const canonical = canonicalizeUrl(c.url);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    deduped.push({ ...c, url: canonical });
  }
  return deduped;
}
