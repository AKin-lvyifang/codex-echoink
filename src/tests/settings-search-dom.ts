import * as assert from "node:assert/strict";
import { App, Platform, Setting } from "obsidian";
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
import { DESKTOP_SETTINGS_TABS, desktopSettingsTabLabel, resolveDesktopSettingsRoute, type DesktopSettingsTab } from "../settings/desktop-settings-route";

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
    applyAppearanceTheme: () => undefined,
    saveSettings: async () => { saved.push(structuredClone(settings)); },
    refreshLanguageSurfaces: async () => undefined,
    getCodexView: () => null,
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
  const tab = new CodexSettingTab(plugin as never);
  // Independent settings windows have their own document and container.
  (tab as any).containerEl = win.document.createElement("div");
  win.document.body.appendChild(tab.containerEl);
  const state = tab as any;
  state.personalMemoryError = "No profile in this disposable fixture";
  state.knowledgePreferenceLoadError = "No saved preferences in this disposable fixture";
  state.resourceLoaded = { plugins: true, skills: true, mcp: true };
  return { tab, plugin, state, saved, registrations, daily, nativeSaves };
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

    const memory = f.tab.containerEl.querySelector<HTMLButtonElement>(`button[aria-label="${language === "en" ? "Use long-term memory" : "使用长期记忆"}"]`)!;
    const beforeMemory = f.plugin.settings.memory.useLongTermMemory;
    assert.ok(memory);
    memory.click();
    await scheduler.flush();
    assert.equal(f.plugin.settings.memory.useLongTermMemory, !beforeMemory);
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
    assert.ok(f.tab.containerEl.querySelector('[data-resource-key="builtin-plugin:finance"]'));
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
    assert.equal(list.querySelector('[data-resource-key="builtin-plugin:finance"]'), null);
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
      ["MCP", "capabilities", '[data-resource-tab="mcp"][aria-selected="true"]', "mcp"],
      ["Skills", "capabilities", '[data-resource-tab="skills"][aria-selected="true"]', "skills"],
      ["知识库", "modules", ".codex-knowledge-settings", "knowledgeBase"]
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
      assert.equal(f.state.desktopRoute[category === "modules" ? "section" : "capabilityTab"], child);
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
    const modelRow = f.tab.containerEl.querySelector('[data-echoink-focus-key="knowledge:provider"]')!;
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
    const changedSelect = f.tab.containerEl.querySelector<HTMLButtonElement>('[data-echoink-focus-key="knowledge:provider"] button[role="combobox"]')!;
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
    assert.equal(f.tab.containerEl.querySelector('[data-echoink-focus-key="knowledge:provider"]'), null, "Knowledge no longer duplicates the global model selector");
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
