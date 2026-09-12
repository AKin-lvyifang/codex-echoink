import type { Setting } from "obsidian";
import type { SettingGroup, SettingsCategoryGroupDefinition } from "../types/obsidian-settings";
import { settingsCopy } from "./i18n";
import type { SettingsLanguage, SettingsTab } from "./settings";

const CATEGORY_ALIASES: Record<SettingsTab, readonly string[]> = {
  general: [
    "基础设置", "General", "语言", "language", "中文", "English", "启动", "startup",
    "日记", "journal", "daily notes", "文件夹", "folder", "长期记忆", "Memory",
    "个性化", "personalization", "人格", "personality", "头像", "avatar"
  ],
  layout: [
    "布局与外观", "Layout", "appearance", "模块", "modules", "首页", "home",
    "工作台", "workbench", "显示", "show", "隐藏", "hide", "待办模块", "todo module"
  ],
  providers: [
    "API Provider", "提供商", "服务商", "模型", "model", "API key", "密钥",
    "连接", "connection", "地址", "base URL", "推理", "reasoning", "上下文", "context"
  ],
  resources: ["Skills & MCP", "资源", "resources", "技能", "skill", "skills", "MCP", "插件", "plugins", "工具", "tools", "服务", "server"],
  knowledgeBase: ["知识库管理", "知识库", "Knowledge", "knowledge base", "初始化", "initialization", "提炼", "refinement", "维护", "maintenance", "wiki", "索引", "index"],
  review: ["复盘", "Review", "周报", "weekly", "月报", "monthly", "报告", "report", "输出", "output", "归档", "archive", "记忆管理", "memory management"],
  todos: ["待办", "todo", "todos", "任务", "task", "分类", "category", "截止日期", "due", "ddl"]
};

/** Index the five real navigation controls, not the fields inside their pages. */
export function settingsCategoryDefinitions(
  language: SettingsLanguage,
  render: (tab: SettingsTab, setting: Setting, group: SettingGroup) => () => void
): SettingsCategoryGroupDefinition[] {
  const names = settingsCopy(language).tabs;
  return [{
    type: "group",
    cls: "echoink-native-settings-group",
    items: (Object.keys(CATEGORY_ALIASES) as SettingsTab[]).map((tab) => ({
      name: names[tab],
      aliases: [...CATEGORY_ALIASES[tab]],
      render: (setting, group) => render(tab, setting, group)
    }))
  }];
}
