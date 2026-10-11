import type { AgentAvatarState } from "../harness/memory/agent-identity-model";
import ayaAvatar from "../../assets/avatars/monochrome-round-set-01/aya.svg";
import boAvatar from "../../assets/avatars/monochrome-round-set-01/bo.svg";
import cleoAvatar from "../../assets/avatars/monochrome-round-set-01/cleo.svg";
import devAvatar from "../../assets/avatars/monochrome-round-set-01/dev.svg";
import emiAvatar from "../../assets/avatars/monochrome-round-set-01/emi.svg";
import finnAvatar from "../../assets/avatars/monochrome-round-set-01/finn.svg";
import giaAvatar from "../../assets/avatars/monochrome-round-set-01/gia.svg";
import hanAvatar from "../../assets/avatars/monochrome-round-set-01/han.svg";
import ivoAvatar from "../../assets/avatars/monochrome-round-set-01/ivo.svg";
import juneAvatar from "../../assets/avatars/monochrome-round-set-01/june.svg";
import linAvatar from "../../assets/avatars/monochrome-round-set-01/lin.svg";
import micaAvatar from "../../assets/avatars/monochrome-round-set-01/mica.svg";
import novaAvatar from "../../assets/avatars/monochrome-round-set-01/nova.svg";
import rioAvatar from "../../assets/avatars/monochrome-round-set-01/rio.svg";
import solAvatar from "../../assets/avatars/monochrome-round-set-01/sol.svg";

export interface AgentAvatarPreset {
  readonly id: string;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly assetPath: string;
}

export const DEFAULT_AGENT_AVATAR_PRESET_ID = "nova";

/** Product order is stable because arrow-key navigation and persisted presetId use it. */
export const AGENT_AVATAR_PRESETS: readonly AgentAvatarPreset[] = Object.freeze([
  preset("nova", "Nova", novaAvatar),
  preset("rio", "Rio", rioAvatar),
  preset("lin", "Lin", linAvatar),
  preset("sol", "Sol", solAvatar),
  preset("mica", "Mica", micaAvatar),
  preset("aya", "Aya", ayaAvatar),
  preset("bo", "Bo", boAvatar),
  preset("cleo", "Cleo", cleoAvatar),
  preset("dev", "Dev", devAvatar),
  preset("emi", "Emi", emiAvatar),
  preset("finn", "Finn", finnAvatar),
  preset("gia", "Gia", giaAvatar),
  preset("han", "Han", hanAvatar),
  preset("ivo", "Ivo", ivoAvatar),
  preset("june", "June", juneAvatar)
]);

export function resolveAgentAvatarPresetAsset(
  presetId: string,
  catalog: readonly AgentAvatarPreset[] = AGENT_AVATAR_PRESETS
): string | null {
  return catalog.find((entry) => entry.id === presetId)?.assetPath ?? null;
}

export function resolveAgentAvatarUrl(
  avatar: AgentAvatarState,
  catalog: readonly AgentAvatarPreset[] = AGENT_AVATAR_PRESETS
): string | null {
  if (avatar.kind === "custom") return avatar.dataUrl;
  if (avatar.kind === "preset") return resolveAgentAvatarPresetAsset(avatar.presetId, catalog);
  return null;
}

function preset(id: string, label: string, assetPath: string): AgentAvatarPreset {
  return Object.freeze({ id, labelZh: label, labelEn: label, assetPath });
}
