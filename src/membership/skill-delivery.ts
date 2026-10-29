import { REMOTE_ONLY_SKILL_IDS } from "../harness/resources/builtin-skills";

export type SkillPlatform = "desktop" | "ios" | "android";
export interface OfficialSkillCatalogEntry {
  id: string; name: string; nameEn: string; summary: string; summaryEn: string;
  tier: "pro"; variant: "full" | "enhanced"; version: string;
  minPluginVersion: string; platforms: SkillPlatform[]; compareUrl: string | null;
}
export interface OfficialSkillCatalog { catalogVersion: string; skills: OfficialSkillCatalogEntry[] }
export interface SkillAuthorization { scope: string; session: string; validUntil: number }
export interface SkillContentResponse {
  id: string; version: string; sha256: string; content: string; issuedAt: number; maxOfflineSeconds: number;
}
export type SkillDeliveryResponse = SkillContentResponse | { id: string; version: string; notModified: true };
export const REMOTE_SKILL_IDS: readonly string[] = [...REMOTE_ONLY_SKILL_IDS, "knowledge-review"];
export const MAX_SKILL_OFFLINE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SKILL_CONTENT_BYTES = 200_000;

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 128): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
export function parseOfficialSkillCatalog(value: unknown): OfficialSkillCatalog {
  const data = record(value);
  if (!text(data.catalogVersion) || !Array.isArray(data.skills) || data.skills.length !== REMOTE_SKILL_IDS.length) throw new Error("Skill 目录格式无效。");
  const seen = new Set<string>();
  const skills = data.skills.map((raw: unknown): OfficialSkillCatalogEntry => {
    const item = record(raw);
    if (!text(item.id) || !REMOTE_SKILL_IDS.includes(item.id) || seen.has(item.id)
      || !text(item.name, 300) || !text(item.nameEn, 300) || !text(item.summary, 4000) || !text(item.summaryEn, 4000)
      || item.tier !== "pro" || item.variant !== (item.id === "knowledge-review" ? "enhanced" : "full")
      || !text(item.version) || !parseSemver(item.minPluginVersion) || !Array.isArray(item.platforms) || !item.platforms.length
      || !item.platforms.every(platform => ["desktop", "ios", "android"].includes(String(platform)))
      || !(item.compareUrl === null || typeof item.compareUrl === "string" && safeSkillCompareUrl(item.compareUrl) !== null)) throw new Error("Skill 目录条目无效。");
    seen.add(item.id);
    return { id: item.id, name: item.name, nameEn: item.nameEn, summary: item.summary, summaryEn: item.summaryEn,
      tier: "pro", variant: item.id === "knowledge-review" ? "enhanced" : "full", version: item.version, minPluginVersion: item.minPluginVersion as string,
      platforms: item.platforms as SkillPlatform[], compareUrl: item.compareUrl };
  });
  return { catalogVersion: data.catalogVersion, skills };
}
export function parseSkillDelivery(value: unknown, id: string): SkillDeliveryResponse {
  const data = record(value);
  if (data.id !== id || !text(data.version)) throw new Error("Skill 正文身份或版本无效。");
  if (data.notModified === true) return { id, version: data.version, notModified: true };
  if (typeof data.content !== "string" || !data.content.trim() || new TextEncoder().encode(data.content).length > MAX_SKILL_CONTENT_BYTES
    || typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(data.sha256)
    || !Number.isSafeInteger(data.issuedAt) || Number(data.issuedAt) <= 0
    || !Number.isSafeInteger(data.maxOfflineSeconds) || Number(data.maxOfflineSeconds) <= 0) throw new Error("Skill 正文格式无效。");
  return { id, version: data.version, sha256: data.sha256, content: data.content,
    issuedAt: Number(data.issuedAt), maxOfflineSeconds: Math.min(Number(data.maxOfflineSeconds), MAX_SKILL_OFFLINE_MS / 1000) };
}
export function safeSkillCompareUrl(value: string): string | null {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function parseSemver(value: unknown): { core: number[]; pre: string[] } | null {
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(value);
  if (!match) return null;
  const core = match.slice(1, 4).map(Number), pre = match[4]?.split(".") ?? [];
  return core.every(Number.isSafeInteger) && !pre.some(part => /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0")) ? { core, pre } : null;
}
export function skillPluginVersionSupported(current: string, minimum: string): boolean {
  const a = parseSemver(current), b = parseSemver(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  if (!a.pre.length || !b.pre.length) return !a.pre.length || b.pre.length > 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const left = a.pre[i], right = b.pre[i];
    if (left === right) continue;
    if (left === undefined || right === undefined) return right === undefined;
    const ln = /^\d+$/u.test(left), rn = /^\d+$/u.test(right);
    if (ln && rn) return left.length !== right.length ? left.length > right.length : left > right;
    return ln !== rn ? !ln : left > right;
  }
  return true;
}
