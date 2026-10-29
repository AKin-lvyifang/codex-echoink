import { skillPluginVersionSupported, type SkillPlatform } from "../membership/skill-delivery";
import { sha256Hex } from "../utils/sha256";

export type ExpertPlatform = SkillPlatform;
/** The service counts the complete compact UTF-8 delivery envelope, including base64. */
export const MAX_EXPERT_PACKAGE_BYTES = 400 * 1024;
export const MAX_EXPERT_OFFLINE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_EXPERT_PERSONA_CHARACTERS = 4000;
export interface ExpertMetadata {
  id: string; name: string; scene: string; summary: string; quote: string;
  tags: [string, string, string]; avatarUrl: string; version: string;
  minPluginVersion: string; platforms: ExpertPlatform[]; status: "draft" | "published";
}
export interface ExpertCatalog { catalogVersion: string; experts: ExpertMetadata[] }
export interface ExpertSkill {
  id: string; name: string; description: string; content: string;
  /** Optional routing metadata; only the package's own skills can be selected. */
  keywords?: string[];
}
export interface ExpertLicense { name: string; source: string; text: string }
export interface ExpertPackageBody extends ExpertMetadata {
  schema: 1; persona: string; skills: ExpertSkill[];
  avatar: { mimeType: "image/webp" | "image/png"; base64: string };
  licenses: ExpertLicense[];
}
export interface ExpertPackageResponse {
  id: string; version: string; content: string; sha256: string; issuedAt: number; maxOfflineSeconds: number;
}
export type ExpertDeliveryResponse = ExpertPackageResponse | { id: string; version: string; notModified: true };

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 4000): value is string => typeof value === "string" && !!value.trim() && value.length <= max;
export const validExpertId = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9-]{0,127}$/u.test(value);
const validVersion = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][\w.-]{0,127}$/u.test(value);
export function safeExpertUrl(value: string, baseUrl?: string): string | null {
  try {
    const url = new URL(value, baseUrl);
    return !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ? url.href : null;
  } catch { return null; }
}
function parseMetadata(value: unknown, baseUrl?: string): ExpertMetadata {
  const data = record(value), avatarUrl = typeof data.avatarUrl === "string" ? safeExpertUrl(data.avatarUrl, baseUrl) : null;
  if (!validExpertId(data.id) || !validVersion(data.version) || !text(data.name, 300) || !text(data.scene, 300)
    || !text(data.summary) || !text(data.quote) || !Array.isArray(data.tags) || data.tags.length !== 3 || !data.tags.every(tag => text(tag, 300))
    || !avatarUrl || typeof data.minPluginVersion !== "string" || !skillPluginVersionSupported(data.minPluginVersion, data.minPluginVersion)
    || !Array.isArray(data.platforms) || !data.platforms.length || !data.platforms.every(platform => ["desktop", "ios", "android"].includes(String(platform)))
    || !["draft", "published"].includes(String(data.status))) throw new Error("专家目录条目无效。");
  return { id: data.id, name: data.name, scene: data.scene, summary: data.summary, quote: data.quote,
    tags: [...data.tags] as [string, string, string], avatarUrl, version: data.version, minPluginVersion: data.minPluginVersion,
    platforms: [...(data.platforms as ExpertPlatform[])], status: data.status as ExpertMetadata["status"] };
}
export function parseExpertCatalog(value: unknown, baseUrl?: string): ExpertCatalog {
  const data = record(value);
  if (!text(data.catalogVersion, 128) || !Array.isArray(data.experts) || data.experts.length > 1000) throw new Error("专家目录格式无效。");
  const experts = data.experts.map(item => parseMetadata(item, baseUrl));
  if (new Set(experts.map(item => item.id)).size !== experts.length) throw new Error("专家目录身份重复。");
  return { catalogVersion: data.catalogVersion, experts };
}
export function parseExpertDelivery(value: unknown, id: string): ExpertDeliveryResponse {
  const data = record(value);
  if (!validExpertId(id) || data.id !== id || !validVersion(data.version)) throw new Error("专家包身份或版本无效。");
  if (new TextEncoder().encode(JSON.stringify(data)).length > MAX_EXPERT_PACKAGE_BYTES) throw new Error("专家包超过 400 KiB 大小限制。");
  if (data.notModified === true) return { id, version: data.version, notModified: true };
  if (!text(data.content, MAX_EXPERT_PACKAGE_BYTES) || typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(data.sha256)
    || !Number.isSafeInteger(data.issuedAt) || Number(data.issuedAt) <= 0
    || !Number.isSafeInteger(data.maxOfflineSeconds) || Number(data.maxOfflineSeconds) <= 0) throw new Error("专家包格式无效。");
  // Hash the original content string: parsing and reserializing would change its bytes.
  if (sha256Hex(data.content) !== data.sha256) throw new Error("专家包校验失败，旧版本已保留。");
  return { id, version: data.version, content: data.content, sha256: data.sha256, issuedAt: Number(data.issuedAt),
    maxOfflineSeconds: Math.min(Number(data.maxOfflineSeconds), MAX_EXPERT_OFFLINE_MS / 1000) };
}
export function parseExpertPackage(response: ExpertPackageResponse, baseUrl: string): ExpertPackageBody {
  let data: Record<string, unknown>;
  try { data = record(JSON.parse(response.content) as unknown); }
  catch { throw new Error("专家包内容格式无效。"); }
  const metadata = parseMetadata(data, baseUrl);
  if (data.schema !== 1 || metadata.id !== response.id || metadata.version !== response.version || !text(data.persona, 16000)
    || Array.from(data.persona).length > MAX_EXPERT_PERSONA_CHARACTERS || !Array.isArray(data.skills) || data.skills.length > 100
    || !Array.isArray(data.licenses) || !data.licenses.length || data.licenses.length > 100) throw new Error("专家包内容无效。");
  const skills = data.skills.map((raw: unknown): ExpertSkill => {
    const item = record(raw);
    if (!validExpertId(item.id) || !text(item.name, 300) || !text(item.description) || !text(item.content, MAX_EXPERT_PACKAGE_BYTES)
      || item.keywords !== undefined && (!Array.isArray(item.keywords) || item.keywords.length > 100 || !item.keywords.every(word => text(word, 128)))) throw new Error("专家预配技能无效。");
    return { id: item.id, name: item.name, description: item.description, content: item.content,
      ...(Array.isArray(item.keywords) ? { keywords: [...item.keywords] as string[] } : {}) };
  });
  if (new Set(skills.map(skill => skill.id)).size !== skills.length) throw new Error("专家预配技能身份重复。");
  const licenses = data.licenses.map((raw: unknown): ExpertLicense => {
    const item = record(raw);
    if (!text(item.name, 300) || !text(item.source, 4000) || !safeExpertUrl(item.source) || !text(item.text, MAX_EXPERT_PACKAGE_BYTES)) throw new Error("专家许可文本无效。");
    return { name: item.name, source: item.source, text: item.text };
  });
  const avatar = record(data.avatar);
  if (!["image/webp", "image/png"].includes(String(avatar.mimeType)) || typeof avatar.base64 !== "string"
    || !avatar.base64 || avatar.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(avatar.base64)) throw new Error("专家头像格式无效。");
  return { ...metadata, schema: 1, persona: data.persona, skills, licenses,
    avatar: { mimeType: avatar.mimeType as ExpertPackageBody["avatar"]["mimeType"], base64: avatar.base64 } };
}
