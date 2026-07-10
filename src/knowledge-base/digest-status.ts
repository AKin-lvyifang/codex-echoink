import {
  RAW_DIGEST_STATUS_DIGESTED,
  RAW_DIGEST_STATUS_FAILED,
  RAW_DIGEST_STATUS_PENDING_REINGEST,
  rawDigestRecordIsTrusted,
  type RawDigestFrontmatterRecord,
  type RawDigestRegistryEntry
} from "./raw-digest";
import type { KnowledgeBaseRawDigestState } from "./types";

export function rawDigestStateForRecord(input: {
  fingerprint: string;
  frontmatter: RawDigestFrontmatterRecord | null;
  previous?: { fingerprint?: string };
  registry?: RawDigestRegistryEntry;
  hasTrackerHint: boolean;
}): KnowledgeBaseRawDigestState {
  if (!input.fingerprint) return "pending";
  if (input.frontmatter?.status === RAW_DIGEST_STATUS_FAILED) return "failed";
  if (rawDigestRecordIsTrusted(input.frontmatter, input.fingerprint)) return "digested";
  if (input.registry?.fingerprint === input.fingerprint || input.previous?.fingerprint === input.fingerprint) return "digested";
  if (
    (input.frontmatter?.fingerprint && input.frontmatter.fingerprint !== input.fingerprint)
    || (input.registry?.fingerprint && input.registry.fingerprint !== input.fingerprint)
    || (input.previous?.fingerprint && input.previous.fingerprint !== input.fingerprint)
  ) {
    return "changed";
  }
  if (
    input.frontmatter?.status === RAW_DIGEST_STATUS_PENDING_REINGEST
    || input.previous
    || input.hasTrackerHint
    || input.frontmatter?.processed
  ) {
    return "calibration";
  }
  return "pending";
}

export function rawDigestStateLabel(state: KnowledgeBaseRawDigestState): string {
  if (state === "digested") return RAW_DIGEST_STATUS_DIGESTED;
  if (state === "calibration") return "待校准";
  if (state === "changed") return RAW_DIGEST_STATUS_PENDING_REINGEST;
  if (state === "failed") return RAW_DIGEST_STATUS_FAILED;
  return "Raw 待提炼";
}
