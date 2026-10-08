import { PRO_CAPABILITIES } from "./types";
import type { CapabilityAccess } from "./types";

export interface ProPluginAccess {
  readonly canEnter: boolean;
  readonly canToggle: boolean;
  readonly canWrite: boolean;
  readonly reason: string | null;
}

/** The current server issues one unified PRO lease. A known signed PRO right
 * proves product eligibility; each advanced action still checks its own right. */
export function hasProPluginAccess(access: CapabilityAccess): boolean {
  return PRO_CAPABILITIES.some(capability => access.checkCapability(capability));
}
export function getProPluginAccess(access: CapabilityAccess, enabled: boolean): ProPluginAccess {
  const qualified = hasProPluginAccess(access);
  return {
    canEnter: enabled || qualified,
    canToggle: qualified,
    canWrite: qualified,
    reason: qualified ? null : capabilityMessage(access, "finance.analysis.generate") ?? "需要有效 PRO，已有资料仍可查看。",
  };
}
export function requireProPluginAction(access: CapabilityAccess, enabled: boolean, action: "enter" | "toggle" | "write"): void {
  const policy = getProPluginAccess(access, enabled);
  if (!(action === "enter" ? policy.canEnter : action === "toggle" ? policy.canToggle : policy.canWrite))
    throw new Error(policy.reason ?? "需要有效 PRO，已有资料仍可查看。");
}
export function requireProPlugin(access: CapabilityAccess): void {
  requireProPluginAction(access, true, "write");
}

/** Missing account infrastructure must never grant paid operations. */
export const unavailableCapabilityAccess: CapabilityAccess = {
  checkCapability: () => false,
  requireCapability: () => {
    throw new Error(
      "此操作需要有效 PRO；请打开设置 → 账号与会员，已有资料仍可查看。",
    );
  },
  subscribe: () => () => {},
};

export function capabilityMessage(
  access: CapabilityAccess,
  capability: Parameters<CapabilityAccess["requireCapability"]>[0],
): string | null {
  try {
    access.requireCapability(capability);
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "请在账号与会员中恢复 PRO 授权。";
  }
}
