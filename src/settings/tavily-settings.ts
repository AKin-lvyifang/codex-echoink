import { setIcon } from "obsidian";
import { createOriginButton, createOriginInput, createOriginSwitch, createOriginRadioGroup } from "./origin-controls";
import { applyAmicroButton } from "./amicro-buttons";
import { createSettingsGroup, createSettingsSection, createSettingsState } from "./settings-v2";
import { searchWeb, normalizeWebSearchSettings, webSearchApiKey, setWebSearchApiKey, webSearchProvider, webSearchErrorMessage, WEB_SEARCH_PROVIDERS, type WebSearchSettings } from "../tools/web-search";

export function renderTavilySettings(parent: HTMLElement, host: {
  settings: { settingsLanguage: string; tavily: WebSearchSettings };
  saveSettings(): Promise<void>;
}, search: typeof searchWeb = searchWeb): void {
  const english = host.settings.settingsLanguage === "en";
  const label = (zh: string, en: string) => english ? en : zh;
  const settings = host.settings.tavily;
  Object.assign(settings, normalizeWebSearchSettings(settings));
  const aligned = parent.closest(".echoink-settings-aligned") !== null;
  const section = createSettingsSection(parent, { title: label("联网搜索", "Web search"), surface: aligned ? "flat" : "group" });
  const card = aligned ? createSettingsGroup(section) : section;
  card.addClass("echoink-tavily-card");
  let generation = 0, pending: AbortController | null = null;
  const row = card.createDiv({ cls: "setting-item echoink-settings-row setting-row" });
  const copy = row.createDiv({ cls: "setting-item-info setting-copy" });
  copy.createDiv({ cls: "setting-item-name", text: label("联网搜索", "Web search") });
  copy.createDiv({ cls: "setting-item-description", text: label("开启后模型可按需搜索网页，只发送搜索词；关闭后从下一轮移除搜索工具。", "The model can search when needed; only the search query is sent. Turning this off removes search from the next turn.") });
  const toggle = createOriginSwitch(row.createDiv({ cls: "setting-item-control setting-controls" }), { attr: { "aria-label": label("联网搜索", "Web search") } });
  toggle.checked = settings.enabled;
  const providers = card.createDiv({ cls: "echoink-web-search-providers" });
  const radios = createOriginRadioGroup(providers, webSearchProvider(settings), label("搜索服务", "Search service"), value => {
    invalidate(); settings.provider = value === "deepseek" ? "deepseek" : "tavily";
    if (!webSearchApiKey(settings)) { settings.enabled = false; toggle.checked = false; show(label("请先填写当前搜索服务的 API Key。", "Enter the selected search service's API key first."), "error"); }
    refreshKey(); save();
  });
  for (const provider of WEB_SEARCH_PROVIDERS) {
    const option = radios.element.createEl("label", { cls: "setting-item echoink-settings-row setting-row echoink-settings-compact-row" });
    option.createDiv({ cls: "setting-item-info setting-copy" }).createDiv({ cls: "setting-item-name", text: provider === "deepseek" ? "DeepSeek" : "Tavily" });
    const radio = radios.addItem(option.createDiv({ cls: "setting-item-control setting-controls" }), provider, false);
    radio.setAttribute("aria-label", provider === "deepseek" ? "DeepSeek" : "Tavily");
  }
  const links = card.createDiv({ cls: "echoink-tavily-links settings-note" });
  const keyLabel = card.createEl("label", { cls: "echoink-tavily-key-label" });
  const keyCopy = aligned ? keyLabel.createDiv({ cls: "echoink-tavily-key-copy" }) : keyLabel;
  keyCopy.createSpan({ text: "API Key" });
  if (aligned) keyCopy.appendChild(links);
  const control = keyLabel.createDiv({ cls: "echoink-tavily-key-control" });
  const input = createOriginInput(control, { attr: { type: "password", autocomplete: "new-password" } });
  const reveal = createOriginButton(control, { attr: { type: "button", "aria-label": label("显示 Key", "Show key"), "aria-pressed": "false" } });
  applyAmicroButton(reveal, { variant: "tertiary" }); setIcon(reveal, "eye");
  reveal.onclick = () => {
    const visible = input.type === "password"; input.type = visible ? "text" : "password";
    reveal.setAttr("aria-pressed", String(visible)); reveal.setAttr("aria-label", visible ? label("隐藏 Key", "Hide key") : label("显示 Key", "Show key")); setIcon(reveal, visible ? "eye-off" : "eye");
  };
  const actions = card.createDiv({ cls: "echoink-tavily-test" });
  const test = createOriginButton(actions, { text: label("测试连接", "Test connection") }, () => { generation++; pending?.abort(); pending = null; });
  applyAmicroButton(test, { variant: "secondary" });
  const cost = actions.createSpan({ cls: "settings-note" });
  if (aligned) control.appendChild(actions);
  const state = card.createDiv({ cls: "echoink-tavily-state" });
  function show(text: string, tone: "error" | "success" | "neutral" = "neutral"): void { state.empty(); createSettingsState(state, text, tone); }
  function invalidate(): void { generation++; pending?.abort(); pending = null; test.disabled = false; state.empty(); }
  function save(): void { void host.saveSettings().catch(() => show(label("保存失败，请重试。", "Could not save settings. Try again."), "error")); }
  function refreshKey(): void {
    const deepseek = webSearchProvider(settings) === "deepseek";
    input.value = webSearchApiKey(settings); input.type = "password";
    input.setAttr("aria-label", `${deepseek ? "DeepSeek" : "Tavily"} API Key`); input.placeholder = deepseek ? "sk-…" : "tvly-…";
    reveal.setAttr("aria-pressed", "false"); reveal.setAttr("aria-label", label("显示 Key", "Show key")); setIcon(reveal, "eye");
    links.empty();
    links.createEl("a", { text: label("官网 / 获取 API Key", "Website / Get an API key"), href: deepseek ? "https://platform.deepseek.com/api_keys" : "https://app.tavily.com", attr: { target: "_blank", rel: "noopener noreferrer" } });
    links.createEl("a", { text: label("官方定价", "Official pricing"), href: deepseek ? "https://api-docs.deepseek.com/zh-cn/guides/search/" : "https://docs.tavily.com/documentation/api-credits", attr: { target: "_blank", rel: "noopener noreferrer" } });
    cost.textContent = deepseek ? label("测试会发送一次搜索请求，按官方搜索定价计费。", "Testing sends one search request, charged at official search rates.") : label("执行一次搜索，消耗 1 积分", "Runs one search and uses 1 credit");
  }
  input.oninput = () => {
    invalidate(); setWebSearchApiKey(settings, input.value);
    if (!webSearchApiKey(settings)) { settings.enabled = false; toggle.checked = false; } save();
  };
  toggle.onchange = () => {
    invalidate();
    if (toggle.checked && !webSearchApiKey(settings)) { toggle.checked = false; show(label("请先填写 API Key。", "Enter an API key first."), "error"); input.focus(); return; }
    settings.enabled = toggle.checked; save();
  };
  test.onclick = async () => {
    if (pending) return;
    if (!webSearchApiKey(settings)) { show(label("请先填写 API Key。", "Enter an API key first."), "error"); input.focus(); return; }
    const revision = ++generation, snapshot = { ...settings }, controller = new AbortController(); pending = controller; test.disabled = true;
    show(label("正在搜索以验证连接…", "Searching to verify the connection…"));
    try {
      await search(snapshot, { query: "Obsidian", maxResults: 1, signal: controller.signal });
      if (revision === generation && card.isConnected) show(label("连接成功，已收到有效搜索响应。", "Connected. Received a valid search response."), "success");
    } catch (error) { if (revision === generation && card.isConnected) show(webSearchErrorMessage(error, english), "error"); }
    finally { if (revision === generation) { pending = null; test.disabled = false; } }
  };
  refreshKey();
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
