/**
 * cognitive-projection.ts — renders the USER.md projection.
 *
 * AGENT.md/current-self is rendered and parsed by agent-self.ts. This module
 * intentionally contains no personality scores or Agent projection.
 */

import {
  isProfileItemRenderable,
  profileSlotDefinition,
  USER_PROFILE_PROJECTION_TARGET_CHARS,
  type UserProfileItem,
  type UserProfileState
} from "./user-profile-core";

export function renderUserMarkdown(state: UserProfileState): string {
  const renderable = projectedProfileItems(state);
  const selected: UserProfileItem[] = [];
  for (const item of renderable) {
    const candidate = renderUserProjection(selected.concat(item));
    if (candidate.length > USER_PROFILE_PROJECTION_TARGET_CHARS) break;
    selected.push(item);
  }
  return renderUserProjection(selected);
}

export function projectedProfileItems(state: UserProfileState): UserProfileItem[] {
  const current = state.items.filter((item) => isProfileItemRenderable(item));
  const explicitKeys = new Set(current
    .filter((item) => item.basis !== "observed_memory")
    .map((item) => item.profileKey));
  return current
    .filter((item) => item.basis !== "observed_memory" || !explicitKeys.has(item.profileKey))
    .sort((left, right) => {
      const leftObserved = left.basis === "observed_memory" ? 1 : 0;
      const rightObserved = right.basis === "observed_memory" ? 1 : 0;
      return leftObserved - rightObserved
        || (profileSlotDefinition(right.profileKey)?.importance ?? 0)
          - (profileSlotDefinition(left.profileKey)?.importance ?? 0)
        || (right.updatedAt ?? right.revision) - (left.updatedAt ?? left.revision)
        || left.profileKey.localeCompare(right.profileKey);
    });
}

function renderUserProjection(items: readonly UserProfileItem[]): string {
  const explicit = items.filter((item) => item.basis !== "observed_memory");
  const observed = items.filter((item) => item.basis === "observed_memory");
  const lines: string[] = [
    "# USER",
    "",
    "本文件是系统生成的当前用户画像速查表。用户明确确认的内容优先；",
    "系统观察仅来自多个独立有效的一级 Memory 或公开经历，供参考，不等于用户亲口确认。",
    "",
    "## 用户明确确认",
    ""
  ];
  if (explicit.length === 0) lines.push("- 尚无已确认内容。");
  else for (const item of explicit) lines.push(renderProfileItemLine(item));
  if (observed.length > 0) {
    lines.push("", "## 系统观察", "");
    for (const item of observed) lines.push(renderProfileItemLine(item));
  }
  lines.push("");
  return lines.join("\n");
}

function renderProfileItemLine(item: UserProfileItem): string {
  const label = profileSlotDefinition(item.profileKey)?.labelZh ?? item.profileKey;
  if (item.basis === "observed_memory") {
    return `- 【${label}】${item.text}（系统观察，供参考）`;
  }
  return `- 【${label}】${item.text}`;
}
