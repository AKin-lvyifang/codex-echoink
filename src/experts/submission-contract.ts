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
