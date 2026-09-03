/**
 * Purpose: Barrel re-export module for database operations across 5 boundaries (feed, ingest, publication, discovery, gate-state).
 * When called: Imported by application modules requiring database access.
 */

export * from "./feed";
export {
  upsertPosts,
  getPostsByUrls,
  markCurated,
  getStaleCurationCandidates,
  getPublishedSlicelessCurationCandidates,
  saveEmbed,
  claimIngestCooldown,
  extendIngestCooldown,
  claimIngestLease,
  releaseIngestLease,
  recordCronIngestAt,
  saveLastRunSummary,
  readLastRunSummary,
  savePostRationale,
  getRationaleByPostId,
  updatePostTopics,
  getTopicBackfillSignature,
  writeConfigValue,
  type PostUpsertInput,
  type PostCurationState,
  type CurationUpdate,
  type CurationCandidate,
  type EmbedResult,
  type PostRationaleInput,
  type TopicSignatureMeta,
  type SourcePolicyRow,
} from "./ingest";
export * from "./publication";
export * from "./discovery";
export * from "./gate-state";
