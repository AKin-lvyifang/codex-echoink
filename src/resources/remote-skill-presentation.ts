import { isRemoteOnlySkill } from "../harness/resources/builtin-skills";
import { hasProPluginAccess, unavailableCapabilityAccess } from "../membership/access";
import type { CapabilityAccess } from "../membership/types";
import type { EchoInkResource } from "./types";
import type { SkillDeliveryState } from "../harness/resources/skill-content";

export function isOfficialRemoteSkill(resource: Readonly<EchoInkResource>): boolean {
  if (resource.kind !== "skill" || resource.metadata?.builtin === false || resource.metadata?.contentSource === "user") return false;
  const id = typeof resource.metadata?.resourceId === "string" ? resource.metadata.resourceId : resource.id;
  return resource.metadata?.contentSource === "official-remote" || isRemoteOnlySkill(id);
}
export function remoteSkillLocked(resource: Readonly<EchoInkResource>, access?: CapabilityAccess | null): boolean {
  return isOfficialRemoteSkill(resource) && !hasProPluginAccess(access ?? unavailableCapabilityAccess);
}
export function skillDeliveryStateText(state: SkillDeliveryState | null, english: boolean): string {
  if (!state) return "";
  if (state.kind === "refresh") return english ? "Connect to refresh" : "需要联网刷新";
  if (state.kind === "error") return state.message;
  const date = new Date(state.until), pad = (n: number) => String(n).padStart(2, "0");
  const until = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return english ? `Offline, available until ${until}` : `离线中，可用到 ${until}`;
}
