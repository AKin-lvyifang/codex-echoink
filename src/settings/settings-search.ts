import { DESKTOP_SETTINGS_TABS, desktopSettingsTabLabel, type DesktopSettingsTab } from "./desktop-settings-route";
import type { Setting } from "obsidian";
import type { SettingGroup, SettingsCategoryGroupDefinition } from "../types/obsidian-settings";
import { settingsCopy } from "./i18n";
import type { SettingsLanguage, SettingsTab } from "./settings";

const CATEGORY_ALIASES: Record<SettingsTab, readonly string[]> = {
  general: [
    "基础设置", "General", "语言", "language", "中文", "English", "启动", "startup",
    "日记", "journal", "daily notes", "文件夹", "folder", "长期记忆", "Memory",
    "Obsidian 原生 CLI", "CLI", "命令行界面", "command line interface", "native features",
    "个性化", "personalization", "人格", "personality", "头像", "avatar",
    "外观", "appearance", "主题", "theme", "颜色", "color", "极简黑白", "荧光笔记", "黄白宣言", "Minimal", "Highlighter", "Manifesto", "echoink-theme"
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
  todos: ["待办", "todo", "todos", "任务", "task", "分类", "category", "截止日期", "due", "ddl", "提醒", "通知", "权限", "reminder", "notification", "permission", "截止时间"],
  account: ["账号", "会员", "订阅", "PRO", "激活", "兑换码", "设备", "头像", "密码", "account", "membership", "subscription", "redeem", "license", "devices", "password", "avatar"]
};

/** Index the real navigation controls, not the fields inside their pages. */
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


/** Index the desktop categories while retaining legacy search terms. */
export function desktopSettingsCategoryDefinitions(
  language: SettingsLanguage,
  render: (tab: DesktopSettingsTab, setting: Setting, group: SettingGroup) => () => void
): SettingsCategoryGroupDefinition[] {
  const aliases: Record<DesktopSettingsTab, readonly string[]> = {
    general: [...CATEGORY_ALIASES.general.filter(alias => !/memory|记忆|个性化|人格|头像|personalization|personality|avatar|journal|日记|folder|文件夹/iu.test(alias)), ...CATEGORY_ALIASES.layout, "快捷 AI 小窗", "Quick AI window", "关于", "检查更新"],
    models: [...CATEGORY_ALIASES.providers, "providers", "agents", "大模型API", "默认模型"],
    agent: ["Agent", "身份", "用户画像", "长期记忆", "Memory", "personality", "avatar", "Dream", "做梦", "归档", "archive", "记忆修正", "自动归档"],
    capabilities: ["能力", "Skills & MCP", "resources", "技能", "Skills", "我的Skill", "MCP Server", "Tavily", "DeepSeek", "联网搜索", "web search", "工具", "tools"],
    modules: [...CATEGORY_ALIASES.knowledgeBase, ...CATEGORY_ALIASES.todos, ...CATEGORY_ALIASES.review.filter(alias => !/archive|归档|memory|记忆/iu.test(alias)), "plugins", "插件", "@Agent", "正文管家", "唤起符号", "@Agent in notes", "Trigger character", "财务", "finance", "记账", "账单", "管理商户", "管理账户", "分析保存位置", "英文日记", "English diary", "移动端英文日记快捷入口", "English diary shortcut on mobile", "首页快捷入口", "Home shortcut", "表达库", "PDF", "MinerU", "默认翻译语言", "选文", "划词", "selection", "提问选项", "提问模板", "日记", "journal", "日记模板", "journal templates", "导入模板", "资料来源", "sources", "知识成果", "收件箱", "收藏保存到", "公众号", "新建子文件夹", "待办分类", "知识提炼偏好", "知识关联", "复原仓库"],
    account: CATEGORY_ALIASES.account
  };
  return [{ type: "group", cls: "echoink-native-settings-group", items: DESKTOP_SETTINGS_TABS.map(tab => ({
    name: desktopSettingsTabLabel(tab, language), aliases: [...aliases[tab]], render: (setting, group) => render(tab, setting, group)
  })) }];
}
