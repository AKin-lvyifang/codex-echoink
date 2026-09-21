import { setIcon } from "obsidian";
import { createOriginButton, createOriginInput, createOriginSwitch } from "./origin-controls";
import { applyAmicroButton } from "./amicro-buttons";
import { createSettingsSection, createSettingsState } from "./settings-v2";
import { searchTavily, tavilyErrorMessage, TavilyError, type TavilySettings } from "../tools/tavily-search";

export function renderTavilySettings(parent: HTMLElement, host: {
  settings: { settingsLanguage: string; tavily: TavilySettings };
  saveSettings(): Promise<void>;
}, search: typeof searchTavily = searchTavily): void {
  const english = host.settings.settingsLanguage === "en";
  const label = (zh: string, en: string) => english ? en : zh;
  const card = createSettingsSection(parent, { title: label("Tavily 联网搜索", "Tavily web search"), surface: "group",
    description: label("为当前对话搜索网页，由你选择的模型阅读结果并回答。只发送搜索词。", "Search the web for this conversation. Your selected model reads the results and answers. Only the search query is sent.") });
  card.addClass("echoink-tavily-card");
  const links = card.createDiv({ cls: "echoink-tavily-links settings-note" });
  links.createEl("a", { text: label("官网 / 获取 API Key", "Website / Get an API key"), href: "https://app.tavily.com", attr: { target: "_blank", rel: "noopener noreferrer" } });
  links.createSpan({ text: label("每月免费 1000 积分；basic 搜索每次 1 积分。", "1,000 free credits per month; basic search uses 1 credit.") });
  links.createEl("a", { text: label("以官方政策为准", "See current official pricing"), href: "https://docs.tavily.com/documentation/api-credits", attr: { target: "_blank", rel: "noopener noreferrer" } });
  const keyLabel = card.createEl("label", { text: "API Key", cls: "echoink-tavily-key-label" });
  const control = keyLabel.createDiv({ cls: "echoink-tavily-key-control" });
  const input = createOriginInput(control, { attr: { type: "password", autocomplete: "new-password", "aria-label": "Tavily API Key", placeholder: "tvly-…" } });
  input.value = host.settings.tavily.apiKey;
  const reveal = createOriginButton(control, { attr: { type: "button", "aria-label": label("显示 Key", "Show key"), "aria-pressed": "false" } });
  applyAmicroButton(reveal, { variant: "tertiary" }); setIcon(reveal, "eye");
  reveal.onclick = () => {
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    reveal.setAttr("aria-pressed", String(visible));
    reveal.setAttr("aria-label", visible ? label("隐藏 Key", "Hide key") : label("显示 Key", "Show key"));
    setIcon(reveal, visible ? "eye-off" : "eye");
  };
  const actions = card.createDiv({ cls: "echoink-tavily-test" });
  const test = createOriginButton(actions, { text: label("测试连接", "Test connection") });
  applyAmicroButton(test, { variant: "secondary" });
  actions.createSpan({ cls: "settings-note", text: label("执行一次搜索，消耗 1 积分", "Runs one search and uses 1 credit") });
  const state = card.createDiv({ cls: "echoink-tavily-state" });
  const show = (text: string, tone: "error" | "success" | "neutral" = "neutral") => { state.empty(); createSettingsState(state, text, tone); };
  const row = card.createDiv({ cls: "setting-item echoink-settings-row setting-row" });
  const copy = row.createDiv({ cls: "setting-item-info setting-copy" });
  copy.createDiv({ cls: "setting-item-name", text: label("联网搜索", "Web search") });
  copy.createDiv({ cls: "setting-item-description", text: label("开启后，模型可按需搜索网页；关闭后从下一轮移除搜索工具。", "Allow the model to search when needed. Turning this off removes search from the next turn.") });
  const toggle = createOriginSwitch(row.createDiv({ cls: "setting-item-control setting-controls" }), { attr: { "aria-label": label("联网搜索", "Web search") } });
  toggle.checked = host.settings.tavily.enabled;
  let generation = 0;
  let pending: AbortController | null = null;
  const save = () => { void host.saveSettings().catch(() => show(label("保存失败，请重试。", "Could not save settings. Try again."), "error")); };
  input.oninput = () => {
    generation++; pending?.abort(); pending = null; test.disabled = false; state.empty();
    host.settings.tavily.apiKey = input.value.trim();
    if (!host.settings.tavily.apiKey) { host.settings.tavily.enabled = false; toggle.checked = false; }
    save();
  };
  toggle.onchange = () => {
    if (toggle.checked && !host.settings.tavily.apiKey.trim()) {
      toggle.checked = false; show(tavilyErrorMessage(new TavilyError("key_missing"), english), "error"); input.focus(); return;
    }
    host.settings.tavily.enabled = toggle.checked; save();
  };
  test.onclick = async () => {
    if (pending) return;
    if (!host.settings.tavily.apiKey.trim()) { show(tavilyErrorMessage(new TavilyError("key_missing"), english), "error"); input.focus(); return; }
    const revision = ++generation;
    const controller = new AbortController(); pending = controller; test.disabled = true;
    show(label("正在搜索以验证连接…", "Searching to verify the connection…"));
    try {
      await search({ apiKey: host.settings.tavily.apiKey, query: "Tavily search API documentation", maxResults: 1, signal: controller.signal });
      if (revision === generation && card.isConnected) show(label("连接成功，已收到有效搜索响应。", "Connected. Received a valid search response."), "success");
    } catch (error) {
      if (revision === generation && card.isConnected) show(tavilyErrorMessage(error, english), "error");
    } finally { if (revision === generation) { pending = null; test.disabled = false; } }
  };
}

export function renderProviderTabs(parent: HTMLElement, active: "models" | "tools", english: boolean, activate: (tab: "models" | "tools", focus: boolean) => void): HTMLElement {
  const tabs = parent.createDiv({ cls: "codex-resource-tabs echoink-provider-tabs", attr: { role: "tablist", "aria-label": english ? "Provider settings" : "Provider 设置" } });
  const ids = ["models", "tools"] as const;
  ids.forEach((id, index) => {
    const button = createOriginButton(tabs, { cls: `codex-resource-tab${active === id ? " is-active" : ""}`, text: id === "models" ? (english ? "Model API" : "大模型 API") : (english ? "Tools" : "tool 工具"), attr: { id: `echoink-provider-tab-${id}`, role: "tab", "aria-selected": String(active === id), "aria-controls": "echoink-provider-panel", tabindex: active === id ? 0 : -1, "data-echoink-focus-key": `provider-tab:${id}` } });
    let pointer = false;
    button.onpointerdown = () => { pointer = true; };
    button.onclick = () => { activate(id, !pointer); pointer = false; };
    button.onkeydown = event => {
      const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : event.key === "ArrowRight" ? (index + 1) % 2 : event.key === "ArrowLeft" ? (index + 1) % 2 : null;
      if (next === null) return; event.preventDefault(); activate(ids[next], true);
    };
  });
  return parent.createDiv({ cls: "echoink-provider-panel", attr: { id: "echoink-provider-panel", role: "tabpanel", "aria-labelledby": `echoink-provider-tab-${active}` } });
}
