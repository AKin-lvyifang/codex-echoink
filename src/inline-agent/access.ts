import { CAUSE } from "../core/error-copy";
import { hasProPluginAccess, requireProPlugin, unavailableCapabilityAccess } from "../membership/access";
import type { CapabilityAccess } from "../membership/types";

export interface InlineAccessHost {
  settings: { inlineAgent: { enabled: boolean }; settingsLanguage?: string };
  accountService?: CapabilityAccess | null;
}
export interface InlineGenerationAccess { allowed: boolean; requiresPro: boolean; message: string }

export function inlineGenerationAccess(host: InlineAccessHost): InlineGenerationAccess {
  const en = host.settings.settingsLanguage === "en";
  const requiresPro = !hasProPluginAccess(host.accountService ?? unavailableCapabilityAccess);
  return { allowed: !requiresPro && host.settings.inlineAgent.enabled, requiresPro,
    message: requiresPro ? CAUSE.proRequired[en ? 1 : 0]
      : en ? "@Agent in notes is disabled. Enable it in Settings → Modules." : "正文管家已停用。请在 设置 → 模块 中启用。" };
}

/** Only new generation uses this check. Reading, committing and stopping never do. */
export function requireInlineGeneration(host: InlineAccessHost): void {
  requireProPlugin(host.accountService ?? unavailableCapabilityAccess);
  if (!host.settings.inlineAgent.enabled) throw new Error(inlineGenerationAccess(host).message);
}
