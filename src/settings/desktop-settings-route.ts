import type { ResourceManagementTab, SettingsTab } from "./settings";

/** Desktop navigation stays separate from the legacy value persisted for mobile. */
export const DESKTOP_SETTINGS_TABS = ["general", "models", "agent", "capabilities", "modules", "account"] as const;
export type DesktopSettingsTab = typeof DESKTOP_SETTINGS_TABS[number];
export type DesktopModuleSection = "knowledgeBase" | "todos" | "review" | "journal";
export type DesktopCapabilityTab = "skills" | "mcp" | "tools";
export interface DesktopSettingsRoute {
  tab: DesktopSettingsTab;
  section?: DesktopModuleSection;
  capabilityTab?: DesktopCapabilityTab;
  focus?: string;
  resourceId?: string;
}
/** A capability route owns one effective resource selection before rendering. */
export function normalizeDesktopSettingsRoute(
  route: DesktopSettingsRoute,
  currentResourceTab: ResourceManagementTab,
  previousCapabilityTab?: DesktopCapabilityTab
): DesktopSettingsRoute {
  if (route.tab !== "capabilities") return { ...route };
  return { ...route, capabilityTab: route.capabilityTab ?? previousCapabilityTab ?? (currentResourceTab === "plugins" ? "skills" : currentResourceTab) };
}

export function desktopSettingsTabLabel(tab: DesktopSettingsTab, language: string): string {
  const labels: Record<DesktopSettingsTab, readonly [string, string]> = {
    general: ["通用", "General"], models: ["模型", "Models"], agent: ["Agent", "Agent"],
    capabilities: ["能力", "Capabilities"], modules: ["模块", "Modules"], account: ["账号与会员", "Account and membership"]
  };
  return labels[tab][language === "en" ? 1 : 0];
}
export function resolveDesktopSettingsRoute(
  legacyTab: SettingsTab | "agents" | DesktopSettingsTab,
  options: { focus?: string; resourceTab?: ResourceManagementTab; resourceId?: string } = {}
): DesktopSettingsRoute {
  const focus = options.focus ?? "";
  if (focus.replace(/^explicit:/u, "") === "knowledge:provider") return { tab: "models", focus: "models:default" };
  const extra = { ...(focus ? { focus } : {}), ...(options.resourceId ? { resourceId: options.resourceId } : {}) };
  if (legacyTab === "agents" || legacyTab === "providers") {
    return { tab: /tavily|tools/iu.test(focus) ? "capabilities" : "models", ...(/tavily|tools/iu.test(focus) ? { capabilityTab: "tools" as const } : {}), ...extra };
  }
  if (legacyTab === "resources") return { tab: options.resourceTab === "plugins" ? "modules" : "capabilities", ...(options.resourceTab !== "plugins" ? { capabilityTab: options.resourceTab ?? "skills" } : {}), ...extra };
  if (legacyTab === "knowledgeBase" || legacyTab === "todos") return { tab: "modules", section: legacyTab, ...extra };
  if (legacyTab === "review") return /memory|archive/iu.test(focus) ? { tab: "agent", ...extra } : { tab: "modules", section: "review", ...extra };
  if (legacyTab === "general" && /memory|identity|personality|personalization|profile|avatar|dream|welcome/iu.test(focus)) return { tab: "agent", ...extra };
  if (legacyTab === "general" && /journal/iu.test(focus)) return { tab: "modules", section: "journal", ...extra };
  return { tab: legacyTab === "layout" ? "general" : legacyTab, ...extra };
}

/** The host already indexes aliases; this only locates the matched function. */
export function resolveDesktopSettingsSearchRoute(tab: DesktopSettingsTab, query: string): DesktopSettingsRoute | null {
  const term = query.trim();
  if (!term) return null;
  if (tab === "capabilities") {
    if (/tavily|tools?|工具|联网/iu.test(term)) return { tab, capabilityTab: "tools" };
    if (/mcp|servers?|服务/iu.test(term)) return { tab, capabilityTab: "mcp" };
    if (/skills?|技能/iu.test(term)) return { tab, capabilityTab: "skills" };
  }
  if (tab === "modules") {
    if (/@agent|正文管家|唤起符号|trigger.*character/iu.test(term)) return { tab, focus: "inline-agent:trigger" };
    if (/移动端英文日记快捷入口|首页快捷入口|home.*shortcut|english.*diary.*shortcut/iu.test(term)) return { tab, focus: "english-diary:home-shortcut" };
    if (/日记模板|journal.*template|template.*journal|导入.*模板/iu.test(term)) return { tab, focus: "journal:templates" };
    if (/待办分类|todo.*categor/iu.test(term)) return { tab, focus: "todo:categories" };
    if (/资料来源|raw.*source|sources?/iu.test(term)) return { tab, focus: "knowledge:sources" };
    if (/初始化|initializ|复原仓库|restore/iu.test(term)) return { tab, focus: /复原|restore/iu.test(term) ? "knowledge:restore" : "knowledge:onboarding" };
    if (/提炼偏好|refin.*prefer/iu.test(term)) return { tab, focus: "knowledge:preferences" };
    if (/知识关联|knowledge.*link/iu.test(term)) return { tab, focus: "knowledge:linking" };
    if (/pdf|mineru|默认翻译语言/iu.test(term)) return { tab, focus: "pdf-reading:settings" };
    if (/finance|财务|账单|记账|商户|分析保存位置/iu.test(term)) return { tab, focus: "finance:settings" };
    if (/english|英文|表达库/iu.test(term)) return { tab, focus: "english-diary:settings" };
    if (/selection|选文|划词|标注|提问选项|提问模板/iu.test(term)) return { tab, focus: "selection-ask:settings" };
    if (/knowledge|知识|wiki|索引|初始化|提炼|维护/iu.test(term)) return { tab, section: "knowledgeBase" };
    if (/todos?|待办|提醒|通知|分类|截止/iu.test(term)) return { tab, section: "todos" };
    if (/review|复盘|周报|月报|报告|output|输出/iu.test(term)) return { tab, section: "review" };
    if (/journal|日记/iu.test(term)) return { tab, section: "journal" };
  }
  if (tab === "agent") {
    if (/auto.*archive|自动归档/iu.test(term)) return { tab, focus: "review:auto-archive" };
    if (/archive|归档/iu.test(term)) return { tab, focus: "review:archives" };
    if (/correction|记忆修正|记忆管理/iu.test(term)) return { tab, focus: "review:memory" };
    if (/profile|画像/iu.test(term)) return { tab, focus: "agent:profile" };
    if (/identity|personality|avatar|身份|人格|头像/iu.test(term)) return { tab, focus: "general:personality-template" };
  }
  return null;
}
