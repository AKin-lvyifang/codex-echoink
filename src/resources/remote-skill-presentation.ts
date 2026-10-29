import { isRemoteOnlySkill } from "../harness/resources/builtin-skills";
import { hasProPluginAccess, unavailableCapabilityAccess } from "../membership/access";
import type { CapabilityAccess } from "../membership/types";
import type { EchoInkResource } from "./types";

export function isOfficialRemoteSkill(resource: Readonly<EchoInkResource>): boolean {
  if (resource.kind !== "skill" || resource.metadata?.builtin === false || resource.metadata?.contentSource === "user") return false;
  const id = typeof resource.metadata?.resourceId === "string" ? resource.metadata.resourceId : resource.id;
  return resource.metadata?.contentSource === "official-remote" || isRemoteOnlySkill(id);
}
export function remoteSkillLocked(resource: Readonly<EchoInkResource>, access?: CapabilityAccess | null): boolean {
  return isOfficialRemoteSkill(resource) && !hasProPluginAccess(access ?? unavailableCapabilityAccess);
}
export function skillDeliveryNotice(english: boolean): string {
  return english
    ? "Official PRO Skills download from EchoInk using your account and device authorization. Requests include the Skill ID, device ID, signed lease, plugin version, platform and optional cached version; no notes or conversations are uploaded. Versioned Markdown is cached in the plugin data directory under skill-cache. Offline use requires a valid device lease and lasts up to 7 days from the full content’s issue time. Reads do not renew it. Sign-out, expiry or a known revocation stops access; a fully offline device cannot learn about a remote revocation immediately. Skill text grants no tools or permissions."
    : "官方 PRO Skill 按需从 EchoInk 下载。请求携带 Skill 标识、设备标识、签名租约、插件版本、平台和可选的缓存版本，不上传笔记或对话。版本化 Markdown 缓存在插件数据目录的 skill-cache 子目录。离线使用须设备租约有效，且距完整正文签发时间不满 7 天；读取不续期。退出、到期或已知撤权后停止提供；完全离线时无法即时获知远端撤权。Skill 正文不授予工具或权限。";
}
