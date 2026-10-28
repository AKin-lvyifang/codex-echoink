import { renderTavilySettings } from "../settings/tavily-settings";
import { type WebSearchSettings, type searchWeb } from "../tools/web-search";
import * as assert from "node:assert/strict";
import { App, Platform, Setting } from "obsidian";
import { openTestModals } from "./obsidian-shim";
import { CodexSettingTab } from "../settings/settings-tab";
import { DEFAULT_SETTINGS, createApiProviderConfig, activateApiProvider, type SettingsLanguage, type SettingsTab } from "../settings/settings";
import { settingsCopy } from "../settings/i18n";
import { disposeOriginControls, type OriginCheckElement } from "../settings/origin-controls";
import { emptyWorkspaceResourceSnapshot } from "../core/workspace-resources";
import type { EchoInkResource } from "../resources/types";
import type { SettingGroup, SettingsCategoryGroupDefinition } from "../types/obsidian-settings";
import { attachSettingsTooltip } from "../settings/settings-v2";
import { paidTestAccess } from "./membership-access";
import { createOriginSelectHostFixture } from "./origin-obsidian-dom-shim";
import { DESKTOP_SETTINGS_TABS, desktopSettingsTabLabel, resolveDesktopSettingsRoute, resolveDesktopSettingsSearchRoute, type DesktopSettingsTab } from "../settings/desktop-settings-route";
import { normalizeAgentRegistry, removeAgentDefinition, setModuleOwner } from "../agents/registry";
import type { AgentDefinition, AgentModuleId } from "../agents/types";
import { profileSlotDefinition, type UserProfileControlSnapshot } from "../harness/memory/user-profile-state";

const categories: SettingsTab[] = ["general", "layout", "providers", "resources", "knowledgeBase", "review", "todos", "account"];

/** Supply Obsidian's DOM helpers while retaining jsdom's real node semantics. */
export function prepareDocument(win: Window & typeof globalThis) {
  const create = function (this: HTMLElement, tag: string, options: any = {}) {
    if (typeof options === "string") options = { cls: options };
    const el = this.ownerDocument.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.text !== undefined) el.textContent = options.text;
    for (const [name, value] of Object.entries(options.attr ?? {})) el.setAttribute(name, String(value));
    if (options.value !== undefined) (el as HTMLInputElement).value = options.value;
    if (options.href) (el as HTMLAnchorElement).href = options.href;
    this.appendChild(el);
    return el;
  };
  Object.assign(win.Element.prototype, {
    empty() { this.replaceChildren(); },
    addClass(...tokens: string[]) { this.classList.add(...tokens); },
    removeClass(...tokens: string[]) { this.classList.remove(...tokens); },
    toggleClass(token: string, force: boolean) { this.classList.toggle(token, force); },
    hasClass(token: string) { return this.classList.contains(token); },
    setText(text: string) { this.textContent = text; },
    setAttr(name: string, value: string) { this.setAttribute(name, value); },
    getAttr(name: string) { return this.getAttribute(name); },
    createEl: create,
    createDiv(options: unknown) { return create.call(this, "div", options); },
    createSpan(options: unknown) { return create.call(this, "span", options); },
    setCssProps(props: Record<string, string>) { for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value); },
    setCssStyles(styles: Record<string, string>) { Object.assign(this.style, styles); },
    scrollIntoView() {},
    hasPointerCapture() { return false; },
    setPointerCapture() {},
    releasePointerCapture() {}
  });
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  win.requestAnimationFrame = (callback) => { frames.set(++sequence, callback); return sequence; };
  win.cancelAnimationFrame = (id) => { frames.delete(id); };
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) as any;
  const observers: { disconnected: boolean }[] = [];
  win.ResizeObserver = class {
    private targets = new Set<Element>();
    get disconnected() { return this.targets.size === 0; }
    constructor() { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  } as any;
  return {
    observers,
    async flush() {
      for (let pass = 0; pass < 12; pass++) {
        await Promise.resolve();
        const batch = [...frames.values()];
        frames.clear();
        for (const callback of batch) callback(pass * 16);
        if (!batch.length) { await new Promise(resolve => setTimeout(resolve, 0)); if (!frames.size) return; }
      }
      assert.fail("Settings redraw failed to settle");
    }
  };
}

export function fixture(win: Window & typeof globalThis, language: SettingsLanguage) {
  const saved: unknown[] = [];
  const registrations: (() => void)[] = [];
  const daily = { folder: "journal", format: "YYYY-MM/YYYY-MM-DD" };
  const nativeSaves: unknown[] = [];
  const registryListeners = new Set<() => void>();
  let profile: UserProfileControlSnapshot = { revision: 0, items: [] };
  const profileSaves: UserProfileControlSnapshot[] = [];
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsLanguage = language;
  settings.settingsTab = "providers";
  const plugin = {
    app: Object.assign(new App(), {
      internalPlugins: { plugins: { "daily-notes": { instance: { options: daily }, loadData: async () => daily,
        saveData: async (value: unknown) => { nativeSaves.push(value); } } } }
    }),
    manifest: { id: "echoink-search-fixture", version: "2.2.0" }, settings,
    register: (cleanup: () => void) => registrations.push(cleanup),
    onConversationCatalogChanged: (_listener: () => void) => () => undefined,
    onAgentRegistryChanged: (listener: () => void) => { registryListeners.add(listener); return () => registryListeners.delete(listener); },
    applyAppearanceTheme: () => undefined,
    saveSettings: async () => { saved.push(structuredClone(settings)); },
    refreshLanguageSurfaces: async () => undefined,
    getCodexView: () => null,
    buildRuntimeEchoInkResourceCatalog: async () => [],
    getAgentCapabilityAvailability: () => ({available:true}),
    saveAgentDefinition: async (agent: AgentDefinition, modules: readonly AgentModuleId[]) => {
      const current = settings.agentRegistry;
      const next = normalizeAgentRegistry({ ...current, agents: current.agents.some(value => value.id === agent.id) ? current.agents.map(value => value.id === agent.id ? { ...agent, identityEdited: true } : value) : [...current.agents, { ...agent, identityEdited: true }] });
      for (const module of Object.keys(current.moduleOwners) as AgentModuleId[]) next.moduleOwners[module] = modules.includes(module) ? agent.id : current.moduleOwners[module] === agent.id ? "sol" : current.moduleOwners[module];
      settings.agentRegistry = next; await plugin.saveSettings(); registryListeners.forEach(listener => listener());
    },
    setAgentModuleOwner: async (module: AgentModuleId, agentId: string) => { settings.agentRegistry = setModuleOwner(settings.agentRegistry, module, agentId); await plugin.saveSettings(); registryListeners.forEach(listener => listener()); },
    getAgentDeleteCounts: async () => ({ total: 0, running: 0 }),
    deleteAgent: async (agentId: string) => { settings.agentRegistry = removeAgentDefinition(settings.agentRegistry, agentId); await plugin.saveSettings(); registryListeners.forEach(listener => listener()); },
    readEchoInkUserProfile: async () => structuredClone(profile),
    saveEchoInkUserProfile: async (input: { profileKey: string; text: string; expectedRevision: number }) => {
      assert.equal(input.expectedRevision, profile.revision); const slot = profileSlotDefinition(input.profileKey); assert.ok(slot);
      const revision = profile.revision + 1;
      profile = { revision, items: [...profile.items.filter(item => item.profileKey !== input.profileKey), { id: `fixture-profile-${revision}`, profileKey: input.profileKey, section: slot.section, text: input.text, basis: "explicit_memory", status: "current", sourceMemoryIds: [`fixture-source-${revision}`], revision }] };
      profileSaves.push(structuredClone(profile)); return { revision };
    },
    deleteEchoInkUserProfile: async (input: { profileKey: string; expectedRevision: number }) => { assert.equal(input.expectedRevision, profile.revision); profile = { revision: profile.revision + 1, items: profile.items.filter(item => item.profileKey !== input.profileKey) }; return { revision: profile.revision }; },
    listPiConversations: async () => [],
    getKnowledgeSurfaceService: () => null,
    lifestyle: { label: () => "财务" },
    getQuickChatWindowController: () => null,
    getTodoReminderService: () => ({
      status: () => ({ enabled: settings.todoReminders.enabled, permission: "unavailable", busy: false, error: "" }),
      subscribe: () => () => undefined,
      setEnabled: async () => ({ ok: false, error: "unavailable" }),
      testNotification: async () => ({ ok: false, error: "unavailable" })
    }),
    getTodoStore: () => ({ completionStatistics: (now: Date) => ({ year: now.getFullYear(), years: [now.getFullYear()], total: 0, today: 0, yearTotal: 0, unknown: 0, days: [], activity: [] }), subscribe: () => () => undefined }),
    isEchoInkOnboardingRequested: () => false,
    consumeKnowledgeLinkingFocus: () => false,
    consumeKnowledgeLinkingTaskId: () => null,
    getEchoInkKnowledgeInitializationState: async () => null,
    getEchoInkKnowledgeBaseStructure: async () => ({ state: "uninitialized", roots: [] }),
    getEchoInkKnowledgeBaseDashboard: async () => null
  };
  Object.assign(plugin.app.vault, { getMarkdownFiles: () => [], getAllFolders: () => [], getAbstractFileByPath: () => null, on: () => ({}), offref: () => undefined });
  const tab = new CodexSettingTab(plugin as never);
  // Independent settings windows have their own document and container.
  (tab as any).containerEl = win.document.createElement("div");
  win.document.body.appendChild(tab.containerEl);
  const state = tab as any;
  state.personalMemoryError = "No profile in this disposable fixture";
  state.knowledgePreferenceLoadError = "No saved preferences in this disposable fixture";
  state.resourceLoaded = { plugins: true, skills: true, mcp: true };
  return { tab, plugin, state, saved, registrations, daily, nativeSaves, profileSaves };
}

/** Model only documented host calls; this does not simulate global search UI. */
export function mountDefinitions(tab: CodexSettingTab) {
  const definition = tab.getSettingDefinitions()[0];
  const host = tab.containerEl.createDiv({ cls: definition.cls });
  const listEl = host.createDiv({ cls: "setting-items" });
  const group = { listEl } as SettingGroup;
  const rows = definition.items.map(item => {
    const setting = new Setting(listEl).setName(item.name);
    return { setting, cleanup: item.render(setting, group) as () => void };
  });
  return { definition, host, listEl, rows, cleanup() { for (const row of rows) row.cleanup(); host.remove(); } };
}

function checkIndexIsCheap() {
  const probes: [string, SettingsTab][] = [
    ["语言", "general"], ["language", "general"], ["日记", "general"], ["journal", "general"],
    ["Memory", "general"], ["长期记忆", "general"], ["模型", "providers"], ["model", "providers"],
    ["Provider", "providers"], ["技能", "resources"], ["Skills", "resources"], ["MCP", "resources"],
    ["知识库", "knowledgeBase"], ["knowledge", "knowledgeBase"], ["复盘", "review"], ["review", "review"], ["会员", "account"], ["subscription", "account"], ["兑换码", "account"], ["devices", "account"]
  ];
  for (const language of ["zh-CN", "en"] as const) {
    const readKeys: PropertyKey[] = [];
    const receiver = Object.create(CodexSettingTab.prototype);
    receiver.plugin = new Proxy({}, { get(_target, key) {
      assert.equal(key, "settings", "index generation must not access services, Vault or credentials");
      return new Proxy({}, { get(_target, name) { readKeys.push(name); assert.equal(name, "settingsLanguage"); return language; } });
    } });
    const groups: SettingsCategoryGroupDefinition[] = receiver.getSettingDefinitions();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].items.length, categories.length);
    assert.deepEqual(groups[0].items.map(item => item.name), categories.map(tab => settingsCopy(language).tabs[tab]));
    for (const item of groups[0].items) {
      assert.equal(typeof item.render, "function");
      assert.equal(item.action, undefined);
      assert.notEqual(item.visible, false);
      assert.notEqual(item.searchable, false);
    }
    for (const [term, category] of probes) {
      const item = groups[0].items[categories.indexOf(category)];
      assert.ok([item.name, ...item.aliases!].join(" ").toLowerCase().includes(term.toLowerCase()), term);
    }
    assert.deepEqual(readKeys, ["settingsLanguage"]);
  }
  console.log("PASS native settings: real bilingual definitions read only the display language");
}

async function checkBuiltinFinancePluginRows(win: Window & typeof globalThis, scheduler: ReturnType<typeof prepareDocument>) {
  for (const language of ["zh-CN", "en"] as const) {
    const f = fixture(win, language);
    const copy = settingsCopy(language);
    const enableCalls: { kind: string; enabled: boolean }[] = [];
    let failSave = false;
    let beforeSave: (() => Promise<void>) | null = null;
    let loads = 0;
    Object.assign(f.plugin, { accountService: paidTestAccess, lifestyle: {
      label: () => "财务",
      async setEnabled(kind: "finance", enabled: boolean) {
        enableCalls.push({ kind, enabled });
        const previous = f.plugin.settings.lifestyle.finance.enabled;
        f.plugin.settings.lifestyle.finance.enabled = enabled;
        try {
          await beforeSave?.();
          if (failSave) throw new Error("synthetic finance setting failure");
          await f.plugin.saveSettings();
        } catch (error) { f.plugin.settings.lifestyle.finance.enabled = previous; throw error; }
      }
    } });
    f.plugin.settings.settingsTab = "resources";
    f.plugin.settings.resourceManagementTab = "plugins";
    f.plugin.settings.resources.catalog = [];
    f.plugin.settings.selectionAsk.enabled = false;
    f.state.runtimeEchoInkResources = [];
    f.state.resourceSnapshot = null;
    f.state.loadWorkspaceResources = async () => { loads++; };
    const render = () => {
      disposeOriginControls(f.tab.containerEl);
      f.tab.containerEl.empty();
      f.state.renderWorkspaceResourceManager(f.tab.containerEl);
      const body = f.tab.containerEl.querySelector<HTMLElement>(".codex-resource-body")!;
      assert.ok(body);
      return body;
    };
    const builtin = () => f.tab.containerEl.querySelector<HTMLElement>('.codex-resource-builtin-plugin[data-resource-key="builtin-plugin:finance"]')!;
    const diary = () => f.tab.containerEl.querySelector<HTMLElement>('.codex-resource-row[data-resource-key="echoink:english-diary"]')!;
    const counts = (total: number, enabled: number) => {
      const summaries = f.tab.containerEl.querySelectorAll<HTMLElement>("[data-resource-summary]");
      assert.equal(summaries.length, 1, "内置插件与外部工具包只显示一个计数");
      assert.equal(summaries[0].dataset.resourceTotal, String(total));
      assert.equal(summaries[0].dataset.resourceEnabled, String(enabled));
    };
    try {
      for (const phase of ["not-loaded", "loading", "loaded"] as const) {
        f.state.resourceLoaded.plugins = phase === "loaded";
        f.state.resourceLoadingTab = phase === "loading" ? "plugins" : null;
        f.state.resourceSnapshot = phase === "loaded" ? emptyWorkspaceResourceSnapshot() : null;
        const body = render();
        assert.ok(builtin(), `${phase}: 财务不依赖外部目录加载`);
        assert.ok(diary(), `${phase}: 英文日记不依赖外部目录加载`);
        assert.equal(body.querySelectorAll(".codex-resource-row").length, 4);
        assert.ok(body.querySelector('[data-resource-key="builtin-plugin:pdf"]'));
        assert.ok(body.querySelector('[data-resource-key="echoink:selection-ask"]'));
        assert.equal(body.querySelector(".echoink-life-plugin-card"), null, "财务使用统一资源行");
        assert.equal(body.textContent?.includes(copy.resources.noPlugins), false);
        assert.equal(body.textContent?.includes(copy.resources.notLoaded), false);
        assert.equal(body.textContent?.includes(copy.resources.loadingTab(copy.resources.tabs.plugins)), false);
        assert.equal(body.getAttribute("aria-busy"), String(phase === "loading"));
        assert.equal(f.tab.containerEl.querySelector<HTMLButtonElement>(".codex-resource-refresh")!.disabled, phase === "loading");
        counts(4, 0);
      }
      assert.equal(loads, 1, "尚未同步时仍沿用现有加载入口");
      const row = builtin();
      for (const pluginRow of [row, diary()]) {
        const badges = pluginRow.querySelectorAll<HTMLElement>(".echoink-plugin-edition-badge");
        assert.equal(badges.length, 1, "财务和日记各显示一个共用徽标");
        assert.ok(badges[0].matches('.codex-resource-preset-badge[data-plugin-edition="pro"]'));
        assert.equal(badges[0].textContent, "PRO");
      }
      const actions = row.querySelectorAll<HTMLButtonElement>(".codex-resource-row-actions button");
      assert.equal(actions.length, 1, "右侧只有设置文字动作");
      const settings = actions[0];
      assert.equal(settings.textContent, language === "en" ? "Settings" : "设置");
      assert.ok(settings.classList.contains("echoink-origin-control"));
      const name = row.querySelector<HTMLButtonElement>(".codex-resource-row-name")!;
      const toggle = row.querySelector<OriginCheckElement>(".codex-resource-toggle")!;
      assert.equal(settings.disabled, false, "PRO can open settings before enabling the plugin");
      assert.equal(name.disabled, false);
      let finishSave!: () => void;
      beforeSave = () => new Promise<void>((resolve) => { finishSave = resolve; });
      toggle.click();
      assert.equal(toggle.disabled, true);
      assert.equal(settings.disabled, true);
      assert.equal(name.disabled, true);
      settings.click(); name.click();
      assert.equal(f.state.settingsDetail, null, "保存期间不能进入设置详情");
      counts(4, 0);
      finishSave();
      await scheduler.flush();
      beforeSave = null;
      assert.equal(toggle.checked, true);
      assert.equal(toggle.disabled, false);
      assert.ok(row.classList.contains("is-enabled"));
      assert.equal(settings.disabled, false);
      assert.equal(name.disabled, false);
      counts(4, 1);
      assert.deepEqual(enableCalls, [{ kind: "finance", enabled: true }]);
      for (const action of [settings, name]) {
        action.click();
        assert.deepEqual(f.state.settingsDetail, { kind: "lifestyle", lifeKind: "finance" });
        assert.ok(f.state.lifestyleSettingsPanel, "操作进入真实财务设置详情");
        f.state.settingsDetail = null;
      }
      failSave = true;
      toggle.click();
      await scheduler.flush();
      assert.equal(f.plugin.settings.lifestyle.finance.enabled, true);
      assert.equal(toggle.checked, true, "保存失败恢复真实开关状态");
      assert.equal(toggle.disabled, false);
      assert.equal(settings.disabled, false);
      assert.ok(row.classList.contains("is-enabled"));
      counts(4, 1);
      failSave = false;
      toggle.click();
      await scheduler.flush();
      assert.equal(toggle.checked, false);
      assert.equal(settings.disabled, false, "PRO keeps settings access after disabling the plugin");
      assert.equal(name.disabled, false);
      counts(4, 0);

      const external: EchoInkResource = { id: "fixture-tools", kind: "tool-bundle", source: "manual", name: "Example connector", description: "External fixture tools", enabled: true, bridgeMode: "plugin-tool" };
      f.plugin.settings.resources.catalog = [external];
      f.state.runtimeEchoInkResources = [external];
      const body = render();
      // Exercise the mixed-row renderer independently of registry discovery rules.
      disposeOriginControls(body);
      body.empty();
      f.state.renderEchoInkResources(body, [external]);
      assert.equal(body.querySelectorAll(".codex-resource-row").length, 3);
      counts(3, 1);
      const search = f.tab.containerEl.querySelector<HTMLInputElement>(".codex-resource-search-input")!;
      const filter = (query: string) => {
        search.value = query;
        search.dispatchEvent(new win.Event("input", { bubbles: true }));
        f.state.clearResourceSearchDebounceTimer();
        f.state.applyResourceSearchFilter("plugins");
      };
      filter(language === "en" ? "Alipay" : "支付宝");
      assert.equal(builtin().classList.contains("is-search-hidden"), false);
      assert.ok(body.querySelector('[data-resource-key="fixture-tools"]')?.classList.contains("is-search-hidden"));
      assert.equal(body.querySelector<HTMLElement>("[data-resource-search-empty]")!.hidden, true);
      assert.ok(body.querySelector(".codex-resource-summary-count")?.textContent?.includes(language === "en" ? "1 shown" : "显示 1"));
      counts(3, 1);
      filter("no-such-fixture-plugin");
      assert.ok(builtin().classList.contains("is-search-hidden"));
      assert.equal(body.querySelector<HTMLElement>("[data-resource-search-empty]")!.hidden, false);
      assert.ok(body.querySelector(".codex-resource-summary-count")?.textContent?.includes(language === "en" ? "0 shown" : "显示 0"));
      f.tab.containerEl.querySelector<HTMLButtonElement>(".codex-resource-search-clear")!.click();
      assert.equal(search.value, "");
      assert.equal(body.querySelectorAll(".codex-resource-row.is-search-hidden").length, 0);
      assert.equal(body.querySelector<HTMLElement>("[data-resource-search-empty]")!.hidden, true);
      counts(3, 1);
      f.state.resourceLoadErrors.plugins = "synthetic external scan failure";
      assert.match(render().textContent ?? "", /资源同步未完成|Resources could not be synchronized/u);
      assert.ok(builtin(), "真正的同步错误不移除可用内置行");
    } finally {
      f.tab.hide();
      f.registrations.forEach(cleanup => cleanup());
      f.tab.containerEl.remove();
      await scheduler.flush();
    }
    console.log(`PASS native plugin rows (${language}): builtin visibility/loading, PRO, unified search/counts, toggle rollback and settings actions`);
  }
}

export async function runBuiltinPluginRowDomTests(primary: Window & typeof globalThis) {
  const scheduler = prepareDocument(primary);
  globalThis.ResizeObserver = primary.ResizeObserver;
  globalThis.requestAnimationFrame = primary.requestAnimationFrame;
  globalThis.cancelAnimationFrame = primary.cancelAnimationFrame;
  await checkBuiltinFinancePluginRows(primary, scheduler);
}

async function checkSettingsTooltipLifecycle(win: Window & typeof globalThis) {
  const surface = win.document.body.createDiv({ cls: "echoink-settings-demo" });
  const enter = (el: HTMLElement) => el.dispatchEvent(new win.MouseEvent("mouseenter"));
  const leave = (el: HTMLElement) => el.dispatchEvent(new win.MouseEvent("mouseleave"));
  try {
    const directories = ["Raw", "Wiki"].map(name => {
      const trigger = surface.createEl("button", { text: name });
      attachSettingsTooltip(trigger, `${name} explanation`, trigger, { interactive: false });
      return { trigger, panel: trigger.querySelector<HTMLElement>('[role="tooltip"]')! };
    });
    for (const { trigger, panel } of directories) {
      enter(trigger);
      assert.equal(surface.querySelectorAll('[role="tooltip"]:not([hidden])').length, 1);
      assert.ok(panel.classList.contains("is-noninteractive"), "directory explanation never catches the pointer over another row");
      leave(trigger);
      assert.equal(panel.hidden, true, "directory tooltip closes in the same event, with no timer delay");
      assert.equal(panel.isConnected, false);
    }
    const { trigger, panel } = directories[0];
    trigger.focus();
    assert.equal(panel.hidden, false, "keyboard focus still reveals the directory explanation");
    assert.equal(trigger.getAttribute("aria-describedby"), panel.id);
    trigger.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(panel.hidden, true);
    trigger.blur(); trigger.focus(); trigger.blur();
    assert.equal(panel.hidden, true, "blur dismisses the keyboard explanation");
    enter(trigger);
    surface.dispatchEvent(new win.Event("scroll"));
    assert.equal(panel.hidden, true, "scroll does not strand a floating explanation");
    enter(trigger);
    trigger.remove();
    await Promise.resolve();
    assert.equal(panel.hidden, true, "removing a row dismisses its tooltip");
    assert.equal(panel.isConnected, false, "removing a row removes its escaped tooltip from the settings surface");

    const help = surface.createEl("button", { text: "Long help" });
    attachSettingsTooltip(help, "Long help that can be scrolled");
    const helpPanel = help.querySelector<HTMLElement>('[role="tooltip"]')!;
    enter(help); leave(help); enter(helpPanel);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(helpPanel.hidden, false, "hovering a regular help panel cancels its grace-period dismissal");
    helpPanel.dispatchEvent(new win.Event("scroll"));
    assert.equal(helpPanel.hidden, false, "regular long help remains readable while scrolling its content");
    leave(helpPanel);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(helpPanel.hidden, true, "leaving regular help still dismisses it");
  } finally { surface.remove(); }
  console.log("PASS settings tooltips: immediate directory leave, pointer/focus/Escape/scroll/teardown, scrollable help retained");
}

export async function runSettingsSearchDomTests(primary: Window & typeof globalThis, secondDocument: () => any) {
  const scheduler = prepareDocument(primary);
  await checkSettingsTooltipLifecycle(primary);
  globalThis.ResizeObserver = primary.ResizeObserver;
  globalThis.requestAnimationFrame = primary.requestAnimationFrame;
  globalThis.cancelAnimationFrame = primary.cancelAnimationFrame;
  Platform.isDesktopApp = false;
  checkIndexIsCheap();
  await checkBuiltinFinancePluginRows(primary, scheduler);
  for (const language of ["zh-CN", "en"] as const) {
    const f = fixture(primary, language);
    let mount = mountDefinitions(f.tab);
    assert.equal(f.plugin.settings.settingsTab, "providers", "render callbacks must not auto-activate categories");
    assert.equal(f.saved.length, 0);
    await scheduler.flush();
    assert.ok(f.tab.containerEl.querySelector(".codex-provider-model-manager"));
    const rowElements = mount.rows.map(row => row.setting.settingEl);
    const buttons = categories.map(category => f.tab.containerEl.querySelector<HTMLButtonElement>(`button[data-settings-tab="${category}"]`)!);
    assert.equal(buttons.filter(Boolean).length, categories.length);
    assert.equal(new Set(buttons).size, categories.length);
    for (let i = 0; i < categories.length; i++) {
      assert.equal(rowElements[i].parentElement, mount.listEl);
      assert.ok(rowElements[i].contains(buttons[i]));
      assert.ok(buttons[i].contains(mount.rows[i].setting.nameEl));
      assert.equal(rowElements[i].hidden, false);
      assert.notEqual(rowElements[i].style.display, "contents");
    }
    buttons[0].click();
    await scheduler.flush();
    assert.equal(f.plugin.settings.settingsTab, "general");
    assert.equal(f.saved.length, 1, "category uses original save chain");
    assert.equal(f.tab.containerEl.querySelector(".echoink-settings-page h2")?.textContent, language === "en" ? "General" : "基础设置");
    for (const row of rowElements) assert.equal(row.parentElement, mount.listEl);
    buttons[0].focus();
    f.tab.display();
    await scheduler.flush();
    assert.equal(primary.document.activeElement, buttons[0]);
    assert.equal(f.tab.containerEl.querySelector('button[data-settings-tab="general"]'), buttons[0]);

    // This legacy General page owns startup settings; memory now lives on desktop Agent.
    const startup = f.tab.containerEl.querySelector<HTMLButtonElement>(`button[aria-label="${settingsCopy(language).general.autoOpen}"]`)!;
    const beforeStartup = f.plugin.settings.autoOpen;
    assert.ok(startup);
    startup.click();
    await scheduler.flush();
    assert.equal(f.plugin.settings.autoOpen, !beforeStartup);
    assert.equal((f.saved.at(-1) as typeof f.plugin.settings).autoOpen, !beforeStartup);
    assert.equal(f.saved.length, 2, "real Origin toggle persists through existing callback");
    const journal = f.tab.containerEl.querySelector<HTMLInputElement>(`input[aria-label="${language === "en" ? "Journal folder" : "日记保存文件夹"}"]`)!;
    assert.ok(journal);
    journal.value = "Notes/Daily";
    journal.dispatchEvent(new primary.Event("blur"));
    await scheduler.flush();
    assert.equal(f.plugin.app.internalPlugins.plugins["daily-notes"].instance.options.folder, "Notes/Daily");
    assert.equal(f.nativeSaves.length, 1, "journal still saves through native Daily notes");
    assert.equal(f.saved.length, 2);

    let updates = 0;
    (f.tab as any).update = () => { updates++; mount.cleanup(); mount = mountDefinitions(f.tab); };
    const languageControl = f.tab.containerEl.querySelector<HTMLButtonElement & { value: string }>(`button[aria-label="${settingsCopy(language).general.settingsLanguage}"]`)!;
    languageControl.value = language === "en" ? "zh-CN" : "en";
    languageControl.dispatchEvent(new primary.Event("change"));
    await scheduler.flush();
    assert.equal(updates, 1, "language refresh invokes the public update flow");
    assert.equal(mount.definition.items[0].name, settingsCopy(f.plugin.settings.settingsLanguage).tabs.general);
    assert.equal(f.tab.containerEl.querySelectorAll(".echoink-native-settings-row").length, categories.length);
    assert.equal(f.tab.containerEl.querySelectorAll(".codex-settings-body").length, 1);

    for (const category of categories.slice(1)) {
      f.tab.containerEl.querySelector<HTMLButtonElement>(`button[data-settings-tab="${category}"]`)!.click();
      await scheduler.flush();
      assert.equal(f.plugin.settings.settingsTab, category);
      assert.equal(f.tab.containerEl.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby"), `echoink-settings-tab-${category}`);
    }
    f.tab.containerEl.querySelector<HTMLButtonElement>('button[data-settings-tab="review"]')!
      .dispatchEvent(new primary.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    await scheduler.flush();
    assert.equal(f.plugin.settings.settingsTab, "knowledgeBase", "native rows preserve keyboard category navigation");
    const savedBeforeCancel = f.saved.length;
    f.state.settingsDetail = "knowledge-preferences";
    f.state.knowledgePreferenceEditor = { savedContent: "saved", draftContent: "edited" };
    let confirmations = 0;
    f.state.confirmKnowledgePreferenceDiscard = async () => { confirmations++; return false; };
    f.tab.containerEl.querySelector<HTMLButtonElement>('button[data-settings-tab="general"]')!.click();
    await scheduler.flush();
    assert.equal(confirmations, 1);
    assert.equal(f.plugin.settings.settingsTab, "knowledgeBase", "cancel keeps the original category and draft");
    assert.equal(f.saved.length, savedBeforeCancel);
    assert.equal(f.state.knowledgePreferenceEditor.draftContent, "edited");
    assert.equal(f.tab.containerEl.querySelectorAll(".echoink-native-settings-row").length, categories.length);
    f.state.settingsDetail = null;
    f.state.knowledgePreferenceEditor = null;
    const latestRows = mount.rows.map(row => row.setting.settingEl);
    mount.cleanup();
    await scheduler.flush();
    assert.equal(f.state.nativeSettingsNavigation, null);
    assert.equal(f.state.displayFrame, null);
    assert.equal(f.state.settingsVisible, false);
    assert.ok(scheduler.observers.every(observer => observer.disconnected), `${scheduler.observers.filter(observer => !observer.disconnected).length} observers still connected after cleanup`);
    assert.ok(latestRows.every(row => !row.isConnected), "host teardown removes its own rows");
    mount = mountDefinitions(f.tab);
    await scheduler.flush();
    assert.equal(f.tab.containerEl.querySelectorAll(".echoink-native-settings-row").length, categories.length);
    f.registrations.forEach(cleanup => cleanup());
    mount.cleanup();
    f.tab.containerEl.remove();
    console.log(`PASS native settings (${language}): stable rows/buttons, original saves, language update, all categories, keyboard/cancel, cleanup/reopen`);
  }

  const secondary = secondDocument();
  try {
    const secondScheduler = prepareDocument(secondary.window);
    const f = fixture(secondary.window, "en");
    const mount = mountDefinitions(f.tab);
    await secondScheduler.flush();
    for (const row of mount.rows) assert.equal(row.setting.nameEl.ownerDocument, secondary.window.document);
    f.tab.containerEl.querySelector<HTMLButtonElement>('button[data-settings-tab="review"]')!.click();
    await secondScheduler.flush();
    assert.equal(f.plugin.settings.settingsTab, "review");
    assert.equal(f.tab.containerEl.querySelectorAll(".echoink-native-settings-row").length, categories.length);
    f.tab.hide();
    mount.cleanup();
    await secondScheduler.flush();
    assert.ok(secondScheduler.observers.every(observer => observer.disconnected));
  } finally { secondary.window.close(); }
  const legacy = fixture(primary, "en");
  assert.equal((legacy.tab as any).update, undefined);
  legacy.tab.display();
  await scheduler.flush();
  assert.equal(legacy.tab.containerEl.querySelectorAll("button[data-settings-tab]").length, categories.length);
  legacy.tab.containerEl.querySelector<HTMLButtonElement>('button[data-settings-tab="general"]')!.click();
  await scheduler.flush();
  assert.ok(legacy.tab.containerEl.querySelector('input[aria-label="Journal folder"]'));
  legacy.tab.hide();
  legacy.tab.containerEl.remove();
  console.log("PASS native settings: mobile eight categories, separate document and legacy display fallback");
  Platform.isDesktopApp = true;
  try {
    await checkDesktopSettings(primary, scheduler, secondDocument);
    await checkDesktopMemoryConflict(primary);
    await checkDesktopMemoryPages(primary, scheduler);
    await checkDesktopEnableSwitches(primary, scheduler);
    await checkDesktopInlineProModule(primary, scheduler);
    await checkDesktopSettingPolish(primary, scheduler);
  } finally { Platform.isDesktopApp = false; }
}


async function checkCapabilitiesFromPlugins(win: Window & typeof globalThis, scheduler: ReturnType<typeof prepareDocument>, language: SettingsLanguage) {
  for (const entry of ["route", "host-search"] as const) {
    const f = fixture(win, language);
    f.state.resourceSnapshot = emptyWorkspaceResourceSnapshot();
    const refreshes: unknown[][] = [];
    f.state.loadWorkspaceResources = async (...args: unknown[]) => { refreshes.push(args); };
    const mount = mountDefinitions(f.tab);
    await scheduler.flush();
    f.tab.openDesktopRoute({ tab: "modules" });
    await scheduler.flush();
    assert.equal(f.plugin.settings.resourceManagementTab, "plugins");
    assert.ok(f.tab.containerEl.querySelector('[data-module="finance"]'));
    if (entry === "route") f.tab.openDesktopRoute({ tab: "capabilities" });
    else {
      const search = win.document.createElement("input");
      search.value = language === "en" ? "Capabilities" : "能力";
      Object.assign(f.plugin.app, { setting: { searchComponent: { inputEl: search } } });
      const row = mount.rows[DESKTOP_SETTINGS_TABS.indexOf("capabilities")].setting.settingEl;
      row.tabIndex = -1;
      row.focus();
    }
    await scheduler.flush();
    assert.equal(f.plugin.settings.resourceManagementTab, "skills", `${entry}: first capability entry must leave the plugin data source`);
    const skills = f.tab.containerEl.querySelector('[data-resource-tab="skills"][aria-selected="true"]');
    assert.ok(skills);
    assert.match(skills.textContent ?? "", /Skills/u);
    const list = f.tab.containerEl.querySelector('.codex-resource-body')!;
    assert.equal(list.getAttribute("aria-labelledby"), "echoink-resource-tab-skills");
    assert.equal(list.querySelector('[data-module="finance"]'), null);
    assert.equal(list.querySelector('[data-resource-key="builtin-plugin:pdf"]'), null);
    assert.match(list.textContent ?? "", /Skill/iu, "the actual list renders the Skills empty state and summary");
    assert.ok(f.tab.containerEl.querySelector('.codex-resource-search-input'));
    const refresh = f.tab.containerEl.querySelector<HTMLButtonElement>('.codex-resource-refresh')!;
    assert.equal(refresh.getAttribute("aria-label"), settingsCopy(language).resources.refreshTitle);
    refresh.click();
    await scheduler.flush();
    assert.deepEqual(refreshes, [[true, "skills"]], "refresh uses the selected Skills data source");
    mount.cleanup();
    f.registrations.forEach(cleanup => cleanup());
    f.tab.containerEl.remove();
    await scheduler.flush();
  }
  console.log(`PASS P11 capability entry (${language}): plugins → generic route/host search renders and refreshes Skills`);
}

async function checkDesktopSettings(
  primary: Window & typeof globalThis,
  scheduler: ReturnType<typeof prepareDocument>,
  secondDocument: () => any
) {
  for (const language of ["zh-CN", "en"] as const) {
    await checkCapabilitiesFromPlugins(primary, scheduler, language);
    const receiver = Object.create(CodexSettingTab.prototype);
    const reads: PropertyKey[] = [];
    receiver.plugin = new Proxy({}, { get(_target, key) {
      assert.equal(key, "settings", "desktop search must not load services or credentials");
      return new Proxy({}, { get(_target, name) { reads.push(name); assert.equal(name, "settingsLanguage"); return language; } });
    } });
    const definitions = receiver.getSettingDefinitions() as SettingsCategoryGroupDefinition[];
    assert.deepEqual(definitions[0].items.map(item => item.name), DESKTOP_SETTINGS_TABS.map(tab => desktopSettingsTabLabel(tab, language)));
    assert.deepEqual(reads, ["settingsLanguage"]);
    const probes: [string, DesktopSettingsTab][] = [
      ["布局与外观", "general"], ["language", "general"], ["关于", "general"],
      ["providers", "models"], ["agents", "models"], ["大模型API", "models"],
      ["Memory", "agent"], ["长期记忆", "agent"], ["archive", "agent"],
      ["Skills", "capabilities"], ["MCP Server", "capabilities"], ["Tavily", "capabilities"],
      ["knowledge", "modules"], ["todo", "modules"], ["review", "modules"], ["journal", "modules"], ["PDF", "modules"],
      ["subscription", "account"], ["兑换码", "account"]
    ];
    for (const [term, category] of probes) {
      const item = definitions[0].items[DESKTOP_SETTINGS_TABS.indexOf(category)];
      assert.ok([item.name, ...item.aliases!].join(" ").toLowerCase().includes(term.toLowerCase()), `${category}: ${term}`);
    }

    const f = fixture(primary, language);
    const keyboardHost = createOriginSelectHostFixture(primary);
    Object.assign(f.plugin.app, keyboardHost.app);
    const firstProvider = createApiProviderConfig("deepseek", "p11-deepseek");
    firstProvider.apiKey = "synthetic-fixture-key";
    const secondProvider = createApiProviderConfig("ollama", "p11-ollama");
    f.plugin.settings.apiProviders = [firstProvider, secondProvider];
    activateApiProvider(f.plugin.settings, firstProvider);
    Object.assign(f.plugin, { activateApiProviderSettings: async (mutate: (settings: typeof f.plugin.settings) => void) => {
      mutate(f.plugin.settings);
      await f.plugin.saveSettings();
    } });
    const legacyTab = f.plugin.settings.settingsTab;
    const protectedSettings = () => JSON.stringify({ resources: f.plugin.settings.resources, agents: f.plugin.settings.agentRegistry, memory: f.plugin.settings.memory });
    const unchangedPermissions = protectedSettings();
    let mount = mountDefinitions(f.tab);
    await scheduler.flush();
    const active = () => f.tab.containerEl.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby");
    const navigate = async (tab: DesktopSettingsTab) => {
      f.tab.containerEl.querySelector<HTMLButtonElement>(`button[data-settings-tab="${tab}"]`)!.click();
      await scheduler.flush();
      assert.equal(active(), `echoink-settings-tab-${tab}`);
    };
    const rows = mount.rows.map(row => row.setting.settingEl);
    const buttons = DESKTOP_SETTINGS_TABS.map(category => f.tab.containerEl.querySelector<HTMLButtonElement>(`button[data-settings-tab="${category}"]`)!);
    assert.equal(buttons.filter(Boolean).length, 6);
    assert.equal(active(), "echoink-settings-tab-models", "legacy providers opens desktop Models");
    for (let i = 0; i < rows.length; i++) {
      assert.equal(rows[i].parentElement, mount.listEl);
      assert.ok(rows[i].contains(buttons[i]));
      assert.ok(buttons[i].contains(mount.rows[i].setting.nameEl));
    }
    for (const tab of DESKTOP_SETTINGS_TABS) await navigate(tab);
    assert.equal(f.saved.length, 0, "desktop navigation is read-only");
    assert.equal(f.plugin.settings.settingsTab, legacyTab, "desktop tabs must not overwrite mobile's persisted value");
    assert.equal(protectedSettings(), unchangedPermissions, "navigation cannot change global switches or Agent assignments");
    await navigate("general");
    buttons[0].focus();
    f.tab.display();
    await scheduler.flush();
    assert.equal(primary.document.activeElement, buttons[0]);
    assert.equal(f.tab.containerEl.querySelector('button[data-settings-tab="general"]'), buttons[0]);
    for (const [label, property] of [[language === "en" ? "Open Agent sidebar on startup" : "启动时打开 Agent 侧栏", "autoOpen"], [language === "en" ? "Open workbench on startup" : "启动时打开工作台", "autoOpenHome"]] as const) {
      const toggle = f.tab.containerEl.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
      assert.ok(toggle);
      const previous = f.plugin.settings[property];
      toggle.click();
      await scheduler.flush();
      assert.equal(f.plugin.settings[property], !previous);
    }
    assert.equal(f.saved.length, 2, "both startup switches persist through original callbacks");
    assert.equal(f.tab.containerEl.querySelector('input[aria-label="Journal folder"]'), null, "journal moved out of desktop General");
    let updates = 0;
    (f.tab as any).update = () => { updates++; mount.cleanup(); mount = mountDefinitions(f.tab); };
    const languageControl = f.tab.containerEl.querySelector<HTMLButtonElement & { value: string }>(`button[aria-label="${settingsCopy(language).general.settingsLanguage}"]`)!;
    languageControl.value = language === "en" ? "zh-CN" : "en";
    languageControl.dispatchEvent(new primary.Event("change"));
    await scheduler.flush();
    assert.equal(updates, 1);
    assert.equal(mount.definition.items[0].name, desktopSettingsTabLabel("general", f.plugin.settings.settingsLanguage));
    assert.equal(f.tab.containerEl.querySelectorAll(".echoink-native-settings-row").length, 6);
    assert.equal(f.tab.containerEl.querySelectorAll(".codex-settings-body").length, 1);
    f.tab.containerEl.querySelector<HTMLButtonElement>('button[data-settings-tab="general"]')!.dispatchEvent(new primary.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    await scheduler.flush();
    assert.equal(active(), "echoink-settings-tab-account");
    assert.equal(primary.document.activeElement?.getAttribute("data-settings-tab"), "account");
    f.tab.containerEl.querySelector<HTMLButtonElement>('button[data-settings-tab="account"]')!.dispatchEvent(new primary.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    await scheduler.flush();
    assert.equal(active(), "echoink-settings-tab-modules");

    const routeCases = [
      ["layout", {}, "general"], ["agents", {}, "models"],
      ["providers", { focus: "providers:tools" }, "capabilities"],
      ["resources", { resourceTab: "skills" }, "capabilities"],
      ["resources", { resourceTab: "mcp" }, "capabilities"],
      ["resources", { resourceTab: "plugins" }, "modules"],
      ["knowledgeBase", {}, "modules"], ["todos", {}, "modules"], ["review", {}, "modules"],
      ["general", { focus: "general:memory" }, "agent"], ["account", {}, "account"]
    ] as const;
    for (const [oldTab, options, target] of routeCases) {
      f.tab.openDesktopRoute(resolveDesktopSettingsRoute(oldTab, options));
      await scheduler.flush();
      assert.equal(active(), `echoink-settings-tab-${target}`, `legacy ${oldTab}/${JSON.stringify(options)}`);
      assert.equal(f.plugin.settings.settingsTab, legacyTab);
    }
    const searchInput = primary.document.createElement("input");
    Object.assign(f.plugin.app, { setting: { searchComponent: { inputEl: searchInput } } });
    for (const [query, category, selector, child] of [
      ["Tavily", "capabilities", ".echoink-tavily-card", "tools"],
      ["DeepSeek", "capabilities", ".echoink-tavily-card", "tools"],
      ["MCP", "capabilities", '[data-resource-tab="mcp"][aria-selected="true"]', "mcp"],
      ["Skills", "capabilities", '[data-resource-tab="skills"][aria-selected="true"]', "skills"],
      ["知识库", "modules", '[data-module="knowledge"].is-expanded [data-echoink-focus-key="knowledge:directory:raw"]', "knowledgeBase"]
    ] as const) {
      await navigate("general");
      searchInput.value = query;
      const button = f.tab.containerEl.querySelector<HTMLButtonElement>(`button[data-settings-tab="${category}"]`)!;
      button.focus();
      await scheduler.flush();
      assert.equal(active(), "echoink-settings-tab-general", "ordinary tab focus does not navigate even with a host query");
      const row = mount.rows[DESKTOP_SETTINGS_TABS.indexOf(category)].setting.settingEl;
      row.tabIndex = -1;
      row.focus();
      await scheduler.flush();
      assert.equal(active(), `echoink-settings-tab-${category}`, `host result row focus routes ${query}`);
      assert.ok(f.tab.containerEl.querySelector(selector), `${query} renders its actual target controls`);
      if (category === "modules") assert.equal(f.state.desktopModuleExpanded.has("knowledge"), true, "Knowledge search expands its live settings drawer");
      else assert.equal(f.state.desktopRoute.capabilityTab, child);
    }
    searchInput.value = "Tavily";
    const capabilityRow = mount.rows[DESKTOP_SETTINGS_TABS.indexOf("capabilities")].setting.settingEl;
    capabilityRow.tabIndex = -1;
    capabilityRow.focus();
    await scheduler.flush();
    const beforeAssignments = JSON.stringify(f.plugin.settings.agentRegistry);
    const key = f.tab.containerEl.querySelector<HTMLInputElement>('input[aria-label="Tavily API Key"]')!;
    assert.equal(key.type, "password");
    key.value = "tvly-synthetic-fixture";
    key.dispatchEvent(new primary.Event("input", { bubbles: true }));
    await scheduler.flush();
    const webToggle = f.tab.containerEl.querySelector<OriginCheckElement>('.echoink-tavily-card button[role="switch"]')!;
    webToggle.click();
    await scheduler.flush();
    assert.equal(f.plugin.settings.tavily.enabled, true);
    assert.equal(f.plugin.settings.tavily.apiKey, "tvly-synthetic-fixture");
    assert.equal(JSON.stringify(f.plugin.settings.agentRegistry), beforeAssignments, "a global capability switch preserves Agent assignments");
    key.value = "";
    key.dispatchEvent(new primary.Event("input", { bubbles: true }));
    await scheduler.flush();
    assert.equal(f.plugin.settings.tavily.enabled, false, "clearing the original Key still turns Tavily off");
    searchInput.value = "";
    f.tab.openDesktopRoute(resolveDesktopSettingsRoute("general", { focus: "general:journal" }));
    await scheduler.flush();
    const currentLanguage = f.plugin.settings.settingsLanguage;
    const journal = f.tab.containerEl.querySelector<HTMLInputElement>(`input[aria-label="${currentLanguage === "en" ? "Journal folder" : "日记保存文件夹"}"]`)!;
    assert.ok(journal, "old journal focus reaches its real relocated field");
    journal.value = "Notes/DesktopDaily";
    journal.dispatchEvent(new primary.Event("blur"));
    await scheduler.flush();
    assert.equal(f.plugin.app.internalPlugins.plugins["daily-notes"].instance.options.folder, "Notes/DesktopDaily");
    assert.equal(f.nativeSaves.length, 1);
    await navigate("models");
    const modelRow = f.tab.containerEl.querySelector('[data-echoink-focus-key="models:default"]')!;
    assert.ok(modelRow);
    const modelSelect = modelRow.querySelector<HTMLButtonElement & { value: string }>('button[role="combobox"]')!;
    assert.ok(modelSelect.querySelector('[data-provider-brand="deepseek"]'), "selected brand is inside the default model control");
    modelSelect.focus();
    modelSelect.dispatchEvent(new primary.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await scheduler.flush();
    const popup = primary.document.querySelector<HTMLElement>('[data-slot="select-content"]')!;
    assert.ok(popup, "default model dropdown opens its actual Origin popup");
    assert.equal(popup.querySelectorAll('[role="group"]').length, 2, "models are grouped by their saved connection");
    assert.equal(popup.querySelectorAll('.echoink-origin-select-group-label').length, 2);
    assert.ok(popup.querySelector('[role="option"] [data-provider-brand="deepseek"]'));
    assert.ok(popup.querySelector('[role="option"] [data-provider-brand="ollama"]'));
    const secondOption = Array.from(popup.querySelectorAll<HTMLElement>('[role="option"]')).find(option => option.querySelector('[data-provider-brand="ollama"]'))!;
    secondOption.focus();
    secondOption.dispatchEvent(new primary.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await scheduler.flush();
    assert.equal(f.plugin.settings.activeApiProviderId, secondProvider.id);
    assert.equal(f.plugin.settings.defaultModel, secondProvider.defaultModelId);
    const changedSelect = f.tab.containerEl.querySelector<HTMLButtonElement>('[data-echoink-focus-key="models:default"] button[role="combobox"]')!;
    assert.ok(changedSelect.querySelector('[data-provider-brand="ollama"]'), "the saved selection updates its in-control brand");
    changedSelect.focus();
    changedSelect.dispatchEvent(new primary.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await scheduler.flush();
    primary.document.activeElement!.dispatchEvent(new primary.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await scheduler.flush();
    assert.equal(primary.document.querySelector('[data-slot="select-content"]'), null);
    assert.equal(primary.document.activeElement, changedSelect, "Escape closes the popup and returns to the selector");
    assert.equal(keyboardHost.depth, 0);
    assert.equal(f.plugin.settings.settingsTab, legacyTab);
    await navigate("modules");
    f.tab.openDesktopRoute(resolveDesktopSettingsRoute("knowledgeBase"));
    await scheduler.flush();
    assert.equal(f.tab.containerEl.querySelector('[data-echoink-focus-key="models:default"], [data-echoink-focus-key="knowledge:provider"]'), null, "Knowledge no longer duplicates the global model selector");

    const openAgentSearchResult = async (query: string) => {
      await navigate("general");
      searchInput.value = query;
      const row = mount.rows[DESKTOP_SETTINGS_TABS.indexOf("agent")].setting.settingEl;
      row.tabIndex = -1; row.focus();
      await scheduler.flush();
      assert.equal(active(), "echoink-settings-tab-agent", `host result row focus routes ${query}`);
    };
    await openAgentSearchResult(currentLanguage === "en" ? "Agent identity" : "编辑身份");
    const agentName = f.tab.containerEl.querySelector<HTMLInputElement>('input[data-field="name"]')!;
    assert.ok(agentName, "identity search opens the shared live Agent editor");
    const editedName = currentLanguage === "en" ? "Search assistant" : "搜索里的总助";
    agentName.value = editedName; agentName.dispatchEvent(new primary.Event("input", { bubbles: true }));
    f.tab.containerEl.querySelector<HTMLButtonElement>('[data-action="save-agent"]')!.click();
    await scheduler.flush();
    assert.equal(f.plugin.settings.agentRegistry.agents.find(agent => agent.id === "sol")?.name, editedName);
    assert.equal(f.tab.containerEl.querySelector('input[data-field="name"]'), null, "saved Agent returns to the settings summary");
    assert.ok(f.tab.containerEl.querySelector('[data-echoink-focus-key="agent:sol:edit"]')?.textContent?.includes(editedName), "the summary reads the saved registry name");

    const profileQuery = currentLanguage === "en" ? "Your profile" : "你的画像";
    await openAgentSearchResult(profileQuery);
    assert.equal(f.tab.containerEl.querySelectorAll("[data-profile-section]").length, 3);
    assert.equal(f.tab.containerEl.querySelectorAll("[data-profile-key]").length, 24);
    assert.equal(f.tab.containerEl.querySelector("textarea[data-profile-focus]"), null, "empty profile slots do not render 24 editors");
    const identityEmpty = f.tab.containerEl.querySelector<HTMLDetailsElement>('[data-profile-section="identity"] details')!;
    identityEmpty.open = true;
    f.tab.containerEl.querySelector<HTMLButtonElement>('[data-profile-focus="identity.name:edit"]')!.click();
    const profileName = f.tab.containerEl.querySelector<HTMLTextAreaElement>('[data-profile-focus="identity.name:input"]')!;
    assert.ok(profileName, "profile search reaches a real inline slot editor");
    profileName.value = "Disposable profile name"; profileName.dispatchEvent(new primary.Event("input", { bubbles: true }));
    f.tab.containerEl.querySelector<HTMLButtonElement>('[data-profile-focus="identity.name:save"]')!.click();
    await scheduler.flush();
    assert.equal(f.profileSaves.length, 1);
    assert.deepEqual(f.profileSaves[0].items.map(item => ({ key: item.profileKey, text: item.text, basis: item.basis })), [{ key: "identity.name", text: "Disposable profile name", basis: "explicit_memory" }]);
    const savedProfileRow = () => f.tab.containerEl.querySelector('[data-profile-key="identity.name"]')!;
    assert.equal(savedProfileRow().querySelector(".echoink-profile-value")?.textContent, "Disposable profile name");
    assert.equal(savedProfileRow().querySelector(".echoink-profile-source")?.textContent, currentLanguage === "en" ? "Confirmed by you" : "你确认的");
    assert.equal(f.tab.containerEl.querySelector('[data-profile-section="identity"] .echoink-profile-count')?.textContent, "1/6");
    f.tab.containerEl.querySelector<HTMLButtonElement>('[data-profile-focus="back"]')!.click();
    await scheduler.flush();
    assert.equal(f.tab.containerEl.querySelector(".echoink-user-profile-settings"), null);
    await openAgentSearchResult(profileQuery);
    assert.equal(savedProfileRow().querySelector(".echoink-profile-value")?.textContent, "Disposable profile name", "reopening the profile reads the saved snapshot");
    f.tab.containerEl.querySelector<HTMLButtonElement>('[data-profile-focus="back"]')!.click();
    await scheduler.flush();
    searchInput.value = "";
    await navigate("modules");
    console.log(`PASS P13 settings search (${language}): host row opens live Agent/profile editors, saves and reads back registry/profile snapshots`);

    f.state.settingsDetail = "knowledge-preferences";
    f.state.knowledgePreferenceEditor = { savedContent: "saved", draftContent: "edited" };
    let confirmations = 0;
    f.state.confirmKnowledgePreferenceDiscard = async () => { confirmations++; return false; };
    await navigate("modules");
    f.tab.containerEl.querySelector<HTMLButtonElement>('button[data-settings-tab="general"]')!.click();
    await scheduler.flush();
    assert.equal(confirmations, 1);
    assert.equal(active(), "echoink-settings-tab-modules");
    assert.equal(f.state.knowledgePreferenceEditor.draftContent, "edited");
    f.state.settingsDetail = null;
    f.state.knowledgePreferenceEditor = null;
    mount.cleanup();
    await scheduler.flush();
    assert.equal(f.state.nativeSettingsNavigation, null);
    assert.equal(f.state.settingsVisible, false);
    mount = mountDefinitions(f.tab);
    await scheduler.flush();
    assert.equal(f.tab.containerEl.querySelectorAll(".echoink-native-settings-row").length, 6);
    mount.cleanup();
    f.registrations.forEach(cleanup => cleanup());
    f.tab.containerEl.remove();
    keyboardHost.dispose();
    console.log(`PASS P11 desktop (${language}): six categories, host search row focus/legacy routes, saves, language, grouped model/brand/selection, keyboard/focus, permissions and cleanup`);
  }
  const secondary = secondDocument();
  try {
    const secondScheduler = prepareDocument(secondary.window);
    const f = fixture(secondary.window, "en");
    const mount = mountDefinitions(f.tab);
    await secondScheduler.flush();
    f.tab.containerEl.querySelector<HTMLButtonElement>('button[data-settings-tab="capabilities"]')!.click();
    await secondScheduler.flush();
    assert.equal(f.tab.containerEl.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby"), "echoink-settings-tab-capabilities");
    for (const row of mount.rows) assert.equal(row.setting.nameEl.ownerDocument, secondary.window.document);
    mount.cleanup();
    await secondScheduler.flush();
    assert.ok(secondScheduler.observers.every(observer => observer.disconnected));
  } finally { secondary.window.close(); }
  console.log("PASS P11 desktop: independent settings document owns controls, listeners and teardown");
}

async function checkDesktopMemoryConflict(win: Window & typeof globalThis) {
  const f = fixture(win, "zh-CN"), state = f.state, plugin = f.plugin as any;
  state.scheduleDisplay = () => {};
  const old = { id: "memory-old", kind: "fact", status: "current", title: "Old", content: "Old content", recallWhen: "When asked", revision: 1 };
  let disk: any = { revision: 1, records: [old], forgottenIds: [] };
  state.personalMemoryState = disk;
  const generated: any[] = [], saves: any[] = [];
  plugin.getEchoInkPersonalMemoryState = async () => disk;
  plugin.generateEchoInkPersonalMemoryCorrection = async (target: any) => { generated.push(target); return { title: "Corrected", content: "New correction", recallWhen: "When asked" }; };
  plugin.applyEchoInkPersonalMemoryCorrection = async (input: any) => { saves.push(input); if (input.expectedRevision !== disk.revision) throw new Error("revision_conflict"); };
  state.openDesktopMemoryCorrection(old);
  const controller = state.desktopCorrection.controller as any;
  let preview = await controller.actions.generate("Keep this draft");
  const newer = { ...old, id: "memory-new", title: "Latest", content: "Updated elsewhere", revision: 2, supersedes: old.id };
  disk = { revision: 2, records: [{ ...old, status: "superseded" }, newer], forgottenIds: [] };
  await assert.rejects(controller.actions.save(preview, "Keep this draft"), /revision_conflict/);
  assert.equal(state.desktopCorrection.id, newer.id);
  assert.equal(state.personalMemoryState.records.find((r: any) => r.status === "current").id, newer.id);
  preview = await controller.actions.generate("Keep this draft");
  assert.equal(generated.at(-1).content, newer.content);
  await controller.actions.save(preview, "Keep this draft");
  assert.equal(saves.at(-1).targetId, newer.id); assert.equal(saves.at(-1).expectedRevision, 2);
  disk = { revision: 3, records: [], forgottenIds: [newer.id] };
  await assert.rejects(controller.actions.generate("Retained after forgetting"), /已失效/);
  const host = win.document.createElement("div"); win.document.body.appendChild(host);
  state.renderDesktopMemoryCorrection(host);
  assert.ok(host.querySelector('.echoink-memory-correction-page'), "invalidated target retains its settings page so navigation can leave");
  assert.match(host.textContent ?? "", /这条记忆已失效/);
  state.desktopCorrection = null; controller.close(); host.remove(); f.tab.containerEl.remove();
  console.log("PASS P13 correction conflict: superseded target refreshes, explicit regeneration freezes new ID/revision, forgotten target keeps accessible draft card");
}

async function checkDesktopMemoryPages(win: Window & typeof globalThis, scheduler: ReturnType<typeof prepareDocument>) {
  const f = fixture(win, "zh-CN"), state = f.state, plugin = f.plugin as any;
  const old = { id: "page-memory", kind: "fact", status: "current", title: "会议时间", content: "上午开会", recallWhen: "安排会议", revision: 1, date: "2026-10-27" };
  let disk: any = { revision: 1, records: [old], forgottenIds: [] };
  let writes = 0, reopen = 0;
  plugin.getEchoInkPersonalMemoryState = async () => disk;
  plugin.generateEchoInkPersonalMemoryCorrection = async () => ({ title: "会议时间", content: "下午开会", recallWhen: "安排会议" });
  plugin.applyEchoInkPersonalMemoryCorrection = async (input: any) => {
    writes++; assert.equal(input.expectedRevision, disk.revision);
    disk = { revision: 2, records: [{ ...old, status: "superseded" }, { ...old, id: "page-memory-new", status: "current", supersedes: old.id, revision: 2, content: input.content }], forgottenIds: [] };
  };
  state.personalMemoryState = disk;
  const mount = mountDefinitions(f.tab);
  const root = f.tab.containerEl;
  Object.defineProperties(root, { scrollHeight: { configurable: true, value: 1600 }, clientHeight: { configurable: true, value: 500 } });
  const button = (text: string) => {
    const result = [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text && !item.closest("[hidden], .is-hidden"));
    assert.ok(result, text); return result;
  };
  const sourceKey = "review:memory:facts:correct:page-memory";
  const sourceButton = () => root.querySelector<HTMLButtonElement>(`[data-echoink-focus-key="${sourceKey}"]`)!;
  const edit = async () => { sourceButton().focus(); sourceButton().click(); await scheduler.flush(); };
  const type = (text: string) => { const input = root.querySelector<HTMLTextAreaElement>("textarea")!; input.value = text; input.dispatchEvent(new win.Event("input", { bubbles: true })); };
  try {
    await scheduler.flush();
    f.tab.openDesktopRoute({ tab: "agent" }); await scheduler.flush();
    state.openSettingsDetail({ kind: "review-memory-category", category: "facts" }); await scheduler.flush();
    root.scrollTop = 280;
    await edit();
    assert.equal(root.querySelector("h2")?.textContent, "修正记忆");
    assert.equal(root.querySelector(".echoink-memory-record-list"), null, "correction replaces the category list");
    assert.equal(root.scrollTop, 0, "the edit page starts at its heading");
    assert.equal(openTestModals.length, 0);
    type("改成下午，其余不变"); root.scrollTop = 120;
    button("生成预览").click(); await scheduler.flush();
    assert.equal(root.querySelector("h2")?.textContent, "预览修正"); assert.equal(root.scrollTop, 0);
    assert.match(root.textContent!, /上午开会/); assert.match(root.textContent!, /下午开会/); assert.match(root.textContent!, /改成下午，其余不变/);
    button("返回修改").click(); await scheduler.flush();
    assert.equal(root.querySelector<HTMLTextAreaElement>("textarea")!.value, "改成下午，其余不变");
    assert.equal(root.scrollTop, 120, "returning from preview restores the edit scroll");
    root.querySelector<HTMLButtonElement>('button[data-settings-tab="general"]')!.click(); await scheduler.flush();
    assert.ok(root.querySelector(".echoink-settings-inline-confirm"), "switching tabs asks before discarding");
    button("继续编辑").click(); await scheduler.flush();
    assert.equal(root.querySelector<HTMLTextAreaElement>("textarea")!.value, "改成下午，其余不变");
    Object.assign(plugin.app, { setting: { open: () => { reopen++; }, openTabById: () => { mountDefinitions(f.tab); }, close: () => {} } });
    f.tab.hide();
    await new Promise(resolve => setTimeout(resolve, 5)); await scheduler.flush();
    assert.equal(reopen, 1); assert.ok(root.querySelector(".echoink-settings-inline-confirm"), "native close remounts the same draft and asks");
    button("继续编辑").click(); await scheduler.flush();
    assert.equal(root.querySelector<HTMLTextAreaElement>("textarea")!.value, "改成下午，其余不变");
    button("取消").click(); button("放弃修改").click(); await scheduler.flush();
    assert.equal(root.querySelector(".echoink-memory-correction-page"), null);
    assert.equal(win.document.activeElement, sourceButton()); assert.equal(root.scrollTop, 280);
    await edit(); type("正式改为下午");
    button("生成预览").click(); await scheduler.flush();
    button("确认保存").click(); await scheduler.flush();
    assert.equal(writes, 1); assert.equal(root.querySelector(".echoink-memory-correction-page"), null);
    assert.match(root.querySelector(".echoink-memory-record-list")!.textContent!, /下午开会/);
    assert.equal(win.document.activeElement?.getAttribute("data-echoink-focus-key"), "review:memory:facts:correct:page-memory-new", "saved replacement restores focus to its new version");
    assert.equal(root.scrollTop, 280);
  } finally { mount.cleanup(); f.registrations.forEach(cleanup => cleanup()); root.remove(); await scheduler.flush(); }
  console.log("PASS desktop memory pages: edit/preview, draft/back, tab/close confirmation, saved replacement and original row scroll/focus");
}

async function checkDesktopEnableSwitches(win: Window & typeof globalThis, scheduler: ReturnType<typeof prepareDocument>) {
  for (const language of ["zh-CN", "en"] as const) {
    const f = fixture(win, language), mount = mountDefinitions(f.tab);
    f.tab.openDesktopRoute({tab:"agent"}); await scheduler.flush();
    const initial = f.plugin.settings.memory.useLongTermMemory;
    const memory = f.tab.containerEl.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${language === "en" ? "Use long-term memory" : "使用长期记忆"}"]`)!;
    assert.ok(memory, "Agent owns the actual localized memory switch");
    assert.equal(memory.getAttribute("data-echoink-focus-key"), "general:memory:enabled");
    memory.click();
    await scheduler.flush();
    assert.equal(f.plugin.settings.memory.useLongTermMemory, !initial, "real click must reach the Radix switch handler");
    assert.equal((f.saved.at(-1) as typeof f.plugin.settings).memory.useLongTermMemory, !initial);
    assert.equal(f.saved.length, 1, "memory switch persists once through its original callback");
    assert.ok(f.tab.containerEl.querySelector('[data-echoink-focus-key="agent:profile"]'), "disabled memory keeps local profile management");
    f.tab.openDesktopRoute({tab:"modules"}); await scheduler.flush();
    const selection = f.plugin.settings.selectionAsk.enabled;
    f.tab.containerEl.querySelector<HTMLButtonElement>('[data-echoink-focus-key="module:selection:enabled"]')!.click();
    await scheduler.flush();
    assert.equal(f.plugin.settings.selectionAsk.enabled, !selection, "module enable click must reach its original save path");
    assert.equal((f.saved.at(-1) as typeof f.plugin.settings).selectionAsk.enabled, !selection);
    assert.equal(f.saved.length, 2, "module switch persists once without activating a sibling drawer");
    f.registrations.forEach(cleanup=>cleanup()); mount.cleanup(); f.tab.containerEl.remove();
    console.log(`PASS real Origin switch clicks (${language}): memory enable and module enable save; no sibling drawer activation`);
  }
}

async function checkDesktopSettingPolish(win: Window & typeof globalThis, scheduler: ReturnType<typeof prepareDocument>) {
  for (const language of ["zh-CN", "en"] as const) {
    const en = language === "en", f = fixture(win, language);
    const plugin = f.plugin as any;
    plugin.accountService = paidTestAccess;
    plugin.settings.englishDiary.enabled = true;
    plugin.settings.englishDiary.homeShortcut = "quick-record";
    plugin.englishDiaryProviderLabel = () => "Fixture model";
    let failSave = false;
    const selections: string[] = [];
    plugin.englishDiary = { setHomeShortcut: async (value: string) => {
      selections.push(value);
      if (failSave) throw new Error("Synthetic shortcut save failure");
      plugin.settings.englishDiary.homeShortcut = value;
      await plugin.saveSettings();
    } };
    const mount = mountDefinitions(f.tab);
    try {
      await scheduler.flush();
      const moduleAliases = mount.definition.items[DESKTOP_SETTINGS_TABS.indexOf("modules")].aliases!;
      for (const term of ["移动端英文日记快捷入口", "English diary shortcut on mobile", "首页快捷入口", "Home shortcut"]) {
        assert.ok(moduleAliases.includes(term), `the host indexes the current and legacy shortcut term: ${term}`);
        const route = resolveDesktopSettingsSearchRoute("modules", term)!;
        assert.equal(route.focus, "english-diary:home-shortcut");
        f.tab.openDesktopRoute(route);
        await scheduler.flush();
        const check = f.tab.containerEl.querySelector<OriginCheckElement>('[data-echoink-focus-key="english-diary:home-shortcut"]')!;
        assert.ok(check, "search opens the actual English diary option");
        assert.equal(check.getAttribute("aria-label"), en ? "English diary shortcut on mobile" : "移动端英文日记快捷入口");
        assert.equal(win.document.activeElement, check, "new and legacy aliases focus the saved option");
      }
      const check = f.tab.containerEl.querySelector<OriginCheckElement>('[data-echoink-focus-key="english-diary:home-shortcut"]')!;
      const row = check.closest(".setting-item")!;
      const help = row.querySelector<HTMLButtonElement>('.echoink-settings-help button')!;
      help.focus();
      const panel = win.document.getElementById(help.getAttribute("aria-describedby")!)!;
      assert.equal(panel.hidden, false);
      assert.equal(panel.textContent, en ? "Replace Quick note on mobile with Write English diary" : "将移动端的快速记录入口改为写英文日记");
      assert.equal(selections.length, 0, "reading the hint never saves a setting");
      help.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      assert.equal(panel.hidden, true);
      check.click(); await scheduler.flush();
      assert.equal(plugin.settings.englishDiary.homeShortcut, "english-diary");
      assert.equal((f.saved.at(-1) as any).englishDiary.homeShortcut, "english-diary");
      assert.equal(check.checked, true);
      failSave = true;
      check.click(); await scheduler.flush();
      assert.equal(plugin.settings.englishDiary.homeShortcut, "english-diary");
      assert.equal(check.checked, true, "a failed save restores the persisted checkbox value");
      assert.equal(check.disabled, false);
      assert.deepEqual(selections, ["english-diary", "quick-record"]);

      f.tab.openDesktopRoute({ tab: "agent" }); await scheduler.flush();
      const auto = f.tab.containerEl.querySelector<HTMLElement>('[data-echoink-focus-key="review:auto-archive"]')!.closest(".setting-item")!;
      assert.equal(auto.querySelector(".setting-item-description")!.textContent, en ? "How long conversations stay inactive before archiving" : "多久没更新的对话自动归档");
      const autoHelp = auto.querySelector<HTMLButtonElement>('.echoink-settings-help button')!;
      autoHelp.focus();
      const autoPanel = win.document.getElementById(autoHelp.getAttribute("aria-describedby")!)!;
      assert.equal(autoPanel.hidden, false);
      assert.equal(autoPanel.textContent, en ? "Conversations in use or with pending drafts are skipped." : "跳过使用中或有待发送内容的对话");
      const archive = f.tab.containerEl.querySelector<HTMLButtonElement>('[data-echoink-focus-key="review:archives"]')!;
      assert.equal(archive.querySelector(".echoink-settings-navigation-description"), null, "archive navigation omits the redundant description");
      archive.focus();
      const archivePanel = win.document.getElementById(archive.getAttribute("aria-describedby")!)!;
      assert.equal(archivePanel.hidden, false);
      assert.equal(archivePanel.textContent, en ? "Deleted conversations cannot be restored in Settings." : "删除后无法在设置中恢复");
      assert.equal(archive.querySelector("button"), null, "navigation help does not nest a button inside its navigation button");
      assert.equal(archive.tagName, "BUTTON"); assert.equal(archive.disabled, false);
      const openedDetails: string[] = [];
      const openDetail = f.state.openSettingsDetail;
      f.state.openSettingsDetail = (detail: string) => { openedDetails.push(detail); };
      try {
        archive.click();
        archive.dispatchEvent(new win.MouseEvent("click", { bubbles: true, detail: 0 }));
        assert.deepEqual(openedDetails, ["review-archives", "review-archives"], "pointer and keyboard-style button activation preserve the archive navigation callback");
      } finally { f.state.openSettingsDetail = openDetail; }

      // A full fail-closed adapter is supplied by production when the account service is absent.
      plugin.accountService = undefined;
      for (const focus of ["account:login", "account:benefits"]) {
        f.tab.openDesktopRoute({ tab: "account", focus }); await scheduler.flush();
        assert.equal(win.document.activeElement?.getAttribute("data-echoink-focus-key"), focus);
        assert.equal(f.tab.containerEl.querySelector(".desktop-account-form"), null, "navigating to an account anchor does not automatically open a sign-in form");
      }
      f.tab.openDesktopRoute({ tab: "modules" }); await scheduler.flush();
      const locked = f.tab.containerEl.querySelector<HTMLButtonElement>('.echoink-module-drawer.is-pro-locked [data-echoink-focus-key="module:english"]')!;
      assert.ok(locked, "missing account service exposes the fail-closed PRO entry");
      locked.click(); await scheduler.flush();
      assert.equal(win.document.activeElement?.getAttribute("data-echoink-focus-key"), "account:benefits", "the locked module reaches the actual account benefits section");
      assert.equal(f.tab.containerEl.querySelector(".desktop-account-form"), null);
    } finally {
      mount.cleanup(); f.registrations.forEach(cleanup => cleanup()); f.tab.containerEl.remove();
      await scheduler.flush();
    }
  }
  console.log("PASS settings polish: current/legacy shortcut search, saved readback/rollback, archive tooltips/navigation, and precise account entry focus");
}

/** This small desktop regression suite can run independently of older mobile fixtures. */
export async function runSettingsPolishDomTests(win: Window & typeof globalThis): Promise<void> {
  const scheduler = prepareDocument(win);
  globalThis.ResizeObserver = win.ResizeObserver;
  globalThis.requestAnimationFrame = win.requestAnimationFrame;
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame;
  const desktop = Platform.isDesktopApp;
  Platform.isDesktopApp = true;
  try { await checkDesktopSettingPolish(win, scheduler); }
  finally { Platform.isDesktopApp = desktop; }
}

async function checkDesktopInlineProModule(win: Window & typeof globalThis, scheduler: ReturnType<typeof prepareDocument>) {
  for (const language of ["zh-CN", "en"] as const) {
    const f = fixture(win, language), plugin = f.plugin as any;
    let paid = true, updates = 0, conflictChecks = 0; const listeners = new Set<() => void>();
    plugin.accountService = { checkCapability: () => paid, requireCapability() { if (!paid) throw new Error("PRO"); }, subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); } };
    plugin.inlineAgent = { refreshAccess() { updates++; }, checkDateConflict() { conflictChecks++; } };
    const mount = mountDefinitions(f.tab);
    try {
      f.tab.openDesktopRoute({ tab: "agent" }); await scheduler.flush();
      assert.equal(f.tab.containerEl.querySelector('[data-echoink-focus-key="inline-agent:trigger"]'), null, "Agent page no longer owns the trigger setting");
      f.tab.openDesktopRoute({ tab: "modules" }); await scheduler.flush();
      const card = () => f.tab.containerEl.querySelector<HTMLElement>('[data-module="inline-agent"]')!;
      assert.match(card().textContent!, language === "en" ? /@Agent in notes/ : /@Agent 正文管家/);
      assert.ok(card().querySelector('[data-plugin-edition="pro"]'));
      card().querySelector<HTMLButtonElement>('[data-echoink-focus-key="module:inline-agent"]')!.click(); await scheduler.flush();
      const trigger = card().querySelector<HTMLInputElement>('[data-echoink-focus-key="inline-agent:trigger"]')!; assert.ok(trigger);
      trigger.value = "!"; trigger.dispatchEvent(new win.Event("change", { bubbles: true })); await scheduler.flush();
      assert.equal(plugin.settings.inlineAgent.trigger, "!"); assert.equal(conflictChecks, 1);
      paid = false; listeners.forEach(fn => fn());
      assert.equal(card().querySelector('[role="switch"]'), null); assert.ok(card().classList.contains("is-pro-locked"));
      assert.equal(plugin.settings.inlineAgent.enabled, true, "expiry retains the saved enable choice");
      plugin.accountService = undefined;
      card().querySelector<HTMLButtonElement>('[data-echoink-focus-key="module:inline-agent"]')!.click(); await scheduler.flush();
      assert.match(f.tab.containerEl.querySelector('.desktop-account-benefits')!.textContent!, /@Agent/);
      plugin.accountService = paidTestAccess; paid = true; f.tab.openDesktopRoute({ tab: "modules" }); await scheduler.flush();
      card().querySelector<HTMLButtonElement>('[data-echoink-focus-key="module:inline-agent:enabled"]')!.click(); await scheduler.flush();
      assert.equal(plugin.settings.inlineAgent.enabled, false); assert.ok(updates >= 2);
      assert.equal((f.saved.at(-1) as any).inlineAgent.enabled, false);
    } finally { mount.cleanup(); f.registrations.forEach(cleanup => cleanup()); f.tab.containerEl.remove(); }
  }
  console.log("PASS @Agent PRO module: bilingual shared drawer/badge/benefits, moved trigger, saved symbol and enable, live membership lock and retained preference");
}

/** Focused production Origin controls; controlled request completion, no external service. */
export async function runWebSearchSettingsDomTests(win: Window & typeof globalThis): Promise<void> {
  const scheduler = prepareDocument(win);
  for (const language of ["zh-CN", "en"]) {
    const container = win.document.createElement("div"); container.className = "echoink-settings-aligned"; win.document.body.append(container);
    const saved: unknown[] = [], calls: { settings: WebSearchSettings; signal?: AbortSignal; resolve: () => void }[] = [];
    const deepseekFixture = ["deepseek", "fixture"].join("-");
    const host = { settings: { settingsLanguage: language, tavily: { enabled: true, apiKey: "tavily-fixture", provider: "tavily", deepseekApiKey: deepseekFixture } as WebSearchSettings }, async saveSettings() { saved.push(structuredClone(this.settings.tavily)); } };
    const search: typeof searchWeb = (settings, input) => new Promise(resolve => { calls.push({ settings, signal: input.signal, resolve: () => resolve({ source: "web", provider: settings.provider === "deepseek" ? "DeepSeek" : "Tavily", results: [] }) }); });
    try {
      renderTavilySettings(container, host, search); await scheduler.flush();
      const input = container.querySelector<HTMLInputElement>('input[type="password"]')!, toggle = container.querySelector<OriginCheckElement>('[role="switch"]')!, test = container.querySelector<HTMLButtonElement>('.echoink-tavily-test button')!;
      const provider = (name: string) => container.querySelector<HTMLButtonElement>(`button[role="radio"][aria-label="${name}"]`)!;
      const edit = (value: string) => { input.value = value; input.dispatchEvent(new win.Event("input", { bubbles: true })); };
      assert.equal(container.querySelectorAll('[role="radio"]').length, 2); assert.equal(provider("Tavily").getAttribute("aria-checked"), "true"); assert.equal(input.value, "tavily-fixture");
      provider("DeepSeek").click(); await scheduler.flush(); assert.equal(input.value, "deepseek-fixture"); assert.equal(provider("DeepSeek").getAttribute("aria-checked"), "true"); assert.equal(provider("Tavily").getAttribute("aria-checked"), "false");
      test.click(); await scheduler.flush(); assert.equal(calls[0].settings.provider, "deepseek"); assert.equal(calls[0].settings.deepseekApiKey, "deepseek-fixture"); assert.equal(test.disabled, true);
      provider("Tavily").click(); await scheduler.flush(); assert.equal(calls[0].signal?.aborted, true); assert.equal(test.disabled, false); assert.equal(input.value, "tavily-fixture");
      calls[0].resolve(); await scheduler.flush(); assert.equal(container.querySelector('.is-success'), null, "a previous provider's late completion cannot mark the current service connected");
      test.click(); await scheduler.flush(); edit("edited-tavily"); assert.equal(calls[1].signal?.aborted, true); calls[1].resolve(); await scheduler.flush(); assert.equal(container.querySelector('.is-success'), null);
      provider("DeepSeek").click(); await scheduler.flush(); assert.equal(input.value, "deepseek-fixture"); edit(""); assert.equal(host.settings.tavily.enabled, false); assert.equal(toggle.checked, false); assert.equal(host.settings.tavily.apiKey, "edited-tavily");
      toggle.click(); await scheduler.flush(); assert.equal(toggle.checked, false); assert.ok(container.querySelector('.is-error'));
      edit("edited-deepseek"); test.click(); await scheduler.flush(); calls[2].resolve(); await scheduler.flush(); assert.ok(container.querySelector('.is-success'), "empty results are a successful connection response"); assert.equal(host.settings.tavily.enabled, false, "test does not enable search");
      toggle.click(); await scheduler.flush(); assert.equal(host.settings.tavily.enabled, true);
      provider("Tavily").click(); await scheduler.flush(); assert.equal(input.value, "edited-tavily"); assert.equal(host.settings.tavily.deepseekApiKey, "edited-deepseek");
      test.click(); await scheduler.flush(); disposeOriginControls(container); assert.equal(calls[3].signal?.aborted, true, "closing settings cancels the current test"); calls[3].resolve(); await scheduler.flush();
      assert.ok(saved.length > 0); assert.ok(!container.textContent?.includes("edited-deepseek"));
    } finally { disposeOriginControls(container); container.remove(); }
  }
  console.log("PASS web search settings: production Origin radios, selected Key/independent storage, enable gate, no-results success, edit/switch/dispose cancellation and stale result suppression; Chinese and English DOM (no live requests)." );
}
