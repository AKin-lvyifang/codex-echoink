import type CodexForObsidianPlugin from "../main";
import { expertModuleEnabled } from "../experts/module";
import { WORKBENCH_MODULES } from "./module-navigation";
import type { WorkbenchNavigationId } from "../settings/workbench-navigation-settings";

export interface WorkbenchNavigationItem { readonly id: WorkbenchNavigationId; readonly icon: string; readonly zh: string; readonly en: string }

export const WORKBENCH_NAVIGATION: readonly WorkbenchNavigationItem[] = [
  ...WORKBENCH_MODULES as readonly WorkbenchNavigationItem[],
  { id: "experts", icon: "sparkles", zh: "专家", en: "Experts" },
  // 资讯不是 Agent 模块，没有负责人。这个工作台视图只在桌面注册，手机端第一期没有入口。
  { id: "news", icon: "newspaper", zh: "资讯", en: "News" }
];
/** The fixed first entry: the workbench's own overview. It is not sortable or hideable. */
export const WORKBENCH_OVERVIEW = { id: "overview", icon: "layout-dashboard", zh: "概览", en: "Overview" } as const;
export type WorkbenchPanelId = WorkbenchNavigationId | typeof WORKBENCH_OVERVIEW.id;

export function workbenchNavigationItem(id: WorkbenchNavigationId): WorkbenchNavigationItem {
  return WORKBENCH_NAVIGATION.find(item => item.id === id)!;
}

/** Entries the product can show here; experts follow their feature switch. */
export function availableWorkbenchNavigation(plugin: CodexForObsidianPlugin): WorkbenchNavigationItem[] {
  return plugin.settings.workbenchNavigation.order.map(workbenchNavigationItem).filter(item => item.id !== "experts" || expertModuleEnabled(plugin));
}

/** User order, minus the entries the user hid in settings. */
export function visibleWorkbenchNavigation(plugin: CodexForObsidianPlugin): WorkbenchNavigationItem[] {
  const hidden = new Set(plugin.settings.workbenchNavigation.hidden);
  return availableWorkbenchNavigation(plugin).filter(item => !hidden.has(item.id));
}

export function isWorkbenchPanelId(value: unknown): value is WorkbenchPanelId {
  return value === WORKBENCH_OVERVIEW.id || WORKBENCH_NAVIGATION.some(item => item.id === value);
}
