import type { IPhonePageContext } from "./workbench-contract";

const messages: Record<string, string> = {
  "设置": "Settings", "通用": "General", "模型": "Models", "能力": "Capabilities", "模块": "Modules", "账号与会员": "Account & membership", "官网 echoink.cn": "Website echoink.cn",
  "智谱 GLM": "Zhipu GLM", "智谱开放平台": "Zhipu open platform", "月之暗面 · 中国版": "Moonshot AI · China", "深度求索": "DeepSeek", "通义千问": "Qwen", "通义千问 Token Plan": "Qwen Token Plan", "阿里云百炼": "Alibaba Cloud Model Studio", "阿里云百炼套餐": "Alibaba Cloud Model Studio plan", "自定义服务": "Custom service", "兼容 OpenAI 接口": "OpenAI-compatible API", "粘贴 API Key": "Paste API Key", "例如 deepseek-chat": "For example, deepseek-chat",
  "外观": "Appearance", "配色": "Palette", "暖白翠绿": "Warm green", "雾紫石墨": "Graphite violet", "界面语言": "Interface language", "启动": "Startup", "启动时打开工作台": "Open workbench at startup", "关于": "About", "关于 EchoInk": "About EchoInk", "组件许可": "Component licenses", "第三方许可": "Third-party licenses", "版本未知": "Version unavailable",
  "默认模型": "Default model", "选择默认模型": "Choose default model", "模型服务": "Model services", "添加模型服务": "Add model service", "填写模型服务": "Configure model service", "编辑模型服务": "Edit model service", "连接名称": "Connection name", "接口地址": "Base URL", "参数": "Parameters", "沿用": "Inherited", "获取模型": "Fetch models", "重新获取": "Fetch again", "读取中…": "Fetching…", "测试中…": "Testing…", "测试并保存": "Test and save", "取消": "Cancel", "删除": "Delete", "删除模型服务": "Delete model service", "删除此模型服务及已选模型？": "Delete this service and its selected models?", "连接": "Connection", "协议": "Protocol", "上下文窗口": "Context window", "模型输出上限": "Model output limit", "单次输出上限": "Request output limit", "支持工具调用": "Tool calling", "图片输入": "Image input", "支持思考": "Reasoning capability", "使用思考": "Enable reasoning", "手动添加 Model ID": "Add Model ID manually", "添加模型": "Add model", "套餐": "Plans", "其他": "Other", "已添加": "Added", "未选择": "Not selected", "未登录": "Signed out", "免费版": "Free",
  "本地模型，只能在电脑上用": "Local models are available on desktop only", "账号登录方式，只能在电脑上用": "Account sign-in is available on desktop only", "此接口暂不支持移动端": "This protocol is unavailable on mobile", "已连接": "Connected", "需要 PRO": "Requires PRO",
  "我的 Agent": "My Agents", "新建 Agent": "New Agent", "模块负责人": "Module owners", "记忆": "Memory", "长期记忆": "Long-term memory", "做梦": "Dream", "移动端未接通": "Unavailable on mobile", "你的画像": "Your profile", "记忆修正": "Edit memories", "会话": "Sessions", "已归档会话": "Archived sessions", "内置技能": "Built-in Skills", "我的 Skill": "My Skills", "添加 MCP 服务": "Add MCP service", "工具": "Tools", "Tavily 联网搜索": "Tavily web search", "基础模块": "Basic modules", "PRO 模块": "PRO modules", "知识库": "Knowledge base", "日记": "Journal", "复盘": "Review", "待办": "Todos", "财务": "Finance", "英文日记": "English diary", "已开启": "On", "已关闭": "Off", "已配置": "Configured", "未启用": "Disabled", "已填写 Key": "Key configured", "未填写 Key": "Key missing", "已初始化": "Initialized", "未初始化": "Not initialized", "未设置": "Not set"
};
export function settingsText(ctx: IPhonePageContext, text: string): string {
  if (ctx.host.settings().settingsLanguage !== "en") return text;
  return messages[text] ?? text.replace(/^(\d+) 个模型$/u, "$1 models").replace(/ · 所有 Agent 默认使用$/u, " · Default for all Agents");
}
export function settingsMessage(ctx: IPhonePageContext, element: HTMLElement, text: string): HTMLElement {
  element.dataset.ipMessage = text; element.textContent = settingsText(ctx, text); return element;
}
export function refreshSettingsLanguage(ctx: IPhonePageContext): void {
  for (const node of Array.from(ctx.document.querySelectorAll<HTMLElement>(".echoink-iphone [data-ip-message]"))) node.textContent = settingsText(ctx, node.dataset.ipMessage!);
  // These are fixed page titles, never user names or model IDs.
  for (const node of Array.from(ctx.document.querySelectorAll<HTMLElement>('.echoink-iphone .eis-page[data-page-id^="iphone-settings-"] .eis-title'))) {
    const original = Object.keys(messages).find(key => messages[key] === node.textContent) ?? node.textContent ?? "";
    node.textContent = settingsText(ctx, original);
  }
}
