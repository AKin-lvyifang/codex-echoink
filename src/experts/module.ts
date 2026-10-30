import type CodexForObsidianPlugin from "../main";
import { hasProPluginAccess } from "../membership/access";

/** An absent preference follows membership; an explicit choice survives expiry. */
export function expertModuleEnabled(plugin: Pick<CodexForObsidianPlugin, "settings" | "accountService">): boolean {
  return typeof plugin.settings.expertsEnabled === "boolean" ? plugin.settings.expertsEnabled
    : !!plugin.accountService && hasProPluginAccess(plugin.accountService);
}
