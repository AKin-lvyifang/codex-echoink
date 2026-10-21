import type { AgentModuleId } from "../agents/types";
import { PRO_CAPABILITIES, type CapabilityAccess } from "../membership/types";
import type { MobileSettings } from "./settings";

type BasicModuleId = "knowledge-base" | "journal" | "review" | "todos";
const basicModule = (module: AgentModuleId): module is BasicModuleId => ["knowledge-base", "journal", "review", "todos"].includes(module);
const writes = new WeakMap<MobileSettings, Promise<void>>();
export interface MobileModuleSettingsHost {
  settings(): MobileSettings;
  saveSettings(): Promise<void>;
  services: { lifestyle: { setEnabled(kind: "finance", value: boolean): Promise<void> } };
  accountService?: Pick<CapabilityAccess, "checkCapability">;
}

/** The user's switch; binding availability and paid access remain separate checks. */
export function mobileModuleEnabled(settings: MobileSettings, module: AgentModuleId): boolean {
  if (basicModule(module)) return settings.mobileUi.moduleEnabled?.[module] !== false;
  if (module === "finance") return settings.lifestyle.finance.enabled;
  if (module === "english-diary") return settings.englishDiary.enabled;
  return false;
}

export function setMobileModuleEnabled(host: MobileModuleSettingsHost, module: AgentModuleId, value: boolean): Promise<void> {
  const settings = host.settings();
  const pending = (writes.get(settings) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (host.settings() !== settings) throw new Error("设置已更新，请重新打开模块设置。");
    if (typeof value !== "boolean") throw new Error("模块开关值无效。");
    if (!basicModule(module) && module !== "finance" && module !== "english-diary") throw new Error("此模块暂不支持在移动端启用。");
    if (!basicModule(module) && !PRO_CAPABILITIES.some(capability => host.accountService?.checkCapability(capability) === true)) throw new Error("此操作需要有效 PRO，原配置已保留。");
    if (mobileModuleEnabled(settings, module) === value) return;
    if (module === "finance") {
      if (!host.services.lifestyle) throw new Error("财务服务尚未就绪，请稍后重试。");
      await host.services.lifestyle.setEnabled("finance", value);
      return;
    }
    if (module === "english-diary") {
      const previous = settings.englishDiary.enabled;
      settings.englishDiary.enabled = value;
      try { await host.saveSettings(); }
      catch {
        if (settings.englishDiary.enabled === value) settings.englishDiary.enabled = previous;
        throw new Error("模块设置保存失败，请重试。");
      }
      return;
    }
    const ui = settings.mobileUi, previousMap = ui.moduleEnabled;
    const previous = previousMap?.[module], hadKey = Object.hasOwn(previousMap ?? {}, module);
    ui.moduleEnabled = { ...previousMap, [module]: value };
    try { await host.saveSettings(); }
    catch {
      if (ui.moduleEnabled?.[module] === value) {
        const restored = { ...ui.moduleEnabled };
        if (hadKey) restored[module] = previous; else delete restored[module];
        if (previousMap === undefined && !Object.keys(restored).length) delete ui.moduleEnabled;
        else ui.moduleEnabled = restored;
      }
      throw new Error("模块设置保存失败，请重试。");
    }
  });
  writes.set(settings, pending);
  return pending;
}
