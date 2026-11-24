import { safeExpertUrl, validExpertId, type ExpertSkill } from "./contracts";
import { isCommunityExpert } from "./source";

export type ExpertSubmissionAvatar = { presetId: string } | { base64: string };
export interface ExpertSubmissionPayload {
  name: string;
  scene: string;
  summary: string;
  quote: string;
  tags: string[];
  examples: string[];
  persona: string;
  skills: Pick<ExpertSkill, "id" | "name" | "description" | "content">[];
  author: { name: string };
  avatar: ExpertSubmissionAvatar;
}
export interface ExpertAvatarPreset { id: string; avatarUrl: string }
export interface ExpertSubmissionReceipt { id: string; version: number; status: "pending" }
export type ExpertReviewStatus = "pending" | "published" | "rejected" | "unlisted";
export interface ExpertSubmissionReview {
  id: string;
  version: number;
  name: string;
  status: ExpertReviewStatus;
  reason: string | null;
  updatedAt: number;
  superseded: boolean;
}
export interface ExpertSubmissionHistory {
  items: ExpertSubmissionReview[];
  total: number;
  page: number;
  pageSize: number;
}
export const MAX_SUBMISSION_AVATAR_BYTES = 1024 * 1024;

export function parseExpertAvatarPresets(value: unknown, baseUrl: string): ExpertAvatarPreset[] {
  const items = (value as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new Error("专家头像列表格式无效。");
  return items.map((item: { id?: unknown; avatarUrl?: unknown } | null) => {
    const url = typeof item?.avatarUrl === "string" && safeExpertUrl(item.avatarUrl, baseUrl);
    if (!url || !validExpertId(item?.id)) throw new Error("专家头像列表格式无效。");
    return { id: item.id, avatarUrl: url };
  });
}

export function parseExpertSubmissionReceipt(value: unknown, expectedId?: string): ExpertSubmissionReceipt {
  const item = value as Partial<ExpertSubmissionReceipt> | null;
  if (!validExpertId(item?.id) || !isCommunityExpert(item.id) || (expectedId && expectedId !== item.id)
    || typeof item.version !== "number" || !Number.isSafeInteger(item.version) || item.version < 1 || item.status !== "pending") {
    throw new Error("投稿回执格式无效。");
  }
  return { id: item.id, version: item.version, status: "pending" };
}

export function parseExpertSubmissionHistory(value: unknown): ExpertSubmissionHistory {
  const history = value as Partial<ExpertSubmissionHistory> | null;
  const validNumber = (n: unknown, min: number): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= min;
  const invalid = () => new Error("投稿审核结果格式无效。");
  if (!Array.isArray(history?.items) || !validNumber(history.total, 0) || !validNumber(history.page, 1)
    || history.pageSize !== 20 || history.page > Math.max(1, Math.ceil(history.total / history.pageSize))
    || history.items.length > Math.min(history.total, history.pageSize)) throw invalid();
  const items = history.items.map((item: Partial<ExpertSubmissionReview> | null): ExpertSubmissionReview => {
    if (!validExpertId(item?.id) || !isCommunityExpert(item.id) || !validNumber(item.version, 1)
      || typeof item.name !== "string" || !item.name.trim() || !validNumber(item.updatedAt, 0)
      || item.updatedAt > 8_640_000_000_000_000 || typeof item.superseded !== "boolean"
      || (item.reason !== null && typeof item.reason !== "string")) throw invalid();
    const { id, version, name, status, reason, updatedAt, superseded } = item;
    if (status !== "pending" && status !== "published" && status !== "rejected" && status !== "unlisted") throw invalid();
    return { id, version, name, status, reason, updatedAt, superseded };
  });
  return { items, total: history.total, page: history.page, pageSize: history.pageSize };
}
