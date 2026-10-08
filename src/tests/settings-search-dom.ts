import * as assert from "node:assert/strict";
import { App, Setting } from "obsidian";
import { CodexSettingTab } from "../settings/settings-tab";
import { DEFAULT_SETTINGS, type SettingsLanguage, type SettingsTab } from "../settings/settings";
import { settingsCopy } from "../settings/i18n";
import { disposeOriginControls, type OriginCheckElement } from "../settings/origin-controls";
import { emptyWorkspaceResourceSnapshot } from "../core/workspace-resources";
import type { EchoInkResource } from "../resources/types";
import type { SettingGroup, SettingsCategoryGroupDefinition } from "../types/obsidian-settings";
import { attachSettingsTooltip } from "../settings/settings-v2";
import { paidTestAccess } from "./membership-access";

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
    getTodoStore: () => ({ completionStatistics: (now: Date) => ({ year: now.getFullYear(), years: [now.getFullYear()], total: 0, today: 0, yearTotal: 0, unknown: 0, days: [], activity: [] }), subscribe: () => () => undefined }),
    isEchoInkOnboardingRequested: () => false,
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
        assert.equal(body.querySelectorAll(".codex-resource-row").length, 2);
        assert.equal(body.querySelector(".echoink-life-plugin-card"), null, "财务使用统一资源行");
        assert.equal(body.textContent?.includes(copy.resources.noPlugins), false);
        assert.equal(body.textContent?.includes(copy.resources.notLoaded), false);
        assert.equal(body.textContent?.includes(copy.resources.loadingTab(copy.resources.tabs.plugins)), false);
        assert.equal(body.getAttribute("aria-busy"), String(phase === "loading"));
        assert.equal(f.tab.containerEl.querySelector<HTMLButtonElement>(".codex-resource-refresh")!.disabled, phase === "loading");
        counts(2, 0);
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
      counts(2, 0);
      finishSave();
      await scheduler.flush();
      beforeSave = null;
      assert.equal(toggle.checked, true);
      assert.equal(toggle.disabled, false);
      assert.ok(row.classList.contains("is-enabled"));
      assert.equal(settings.disabled, false);
      assert.equal(name.disabled, false);
      counts(2, 1);
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
      counts(2, 1);
      failSave = false;
      toggle.click();
      await scheduler.flush();
      assert.equal(toggle.checked, false);
      assert.equal(settings.disabled, false, "PRO keeps settings access after disabling the plugin");
      assert.equal(name.disabled, false);
      counts(2, 0);

      const external: EchoInkResource = { id: "fixture-tools", kind: "tool-bundle", source: "manual", name: "Example connector", description: "External fixture tools", enabled: true, bridgeMode: "plugin-tool" };
      f.plugin.settings.resources.catalog = [external];
      f.state.runtimeEchoInkResources = [external];
      const body = render();
      // Exercise the mixed-row renderer independently of registry discovery rules.
      disposeOriginControls(body);
      body.empty();
      f.state.renderEchoInkResources(body, [external]);
      assert.equal(body.querySelectorAll(".codex-resource-row").length, 2);
      counts(2, 1);
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
      counts(2, 1);
      filter("no-such-fixture-plugin");
      assert.ok(builtin().classList.contains("is-search-hidden"));
      assert.equal(body.querySelector<HTMLElement>("[data-resource-search-empty]")!.hidden, false);
      assert.ok(body.querySelector(".codex-resource-summary-count")?.textContent?.includes(language === "en" ? "0 shown" : "显示 0"));
      f.tab.containerEl.querySelector<HTMLButtonElement>(".codex-resource-search-clear")!.click();
      assert.equal(search.value, "");
      assert.equal(body.querySelectorAll(".codex-resource-row.is-search-hidden").length, 0);
      assert.equal(body.querySelector<HTMLElement>("[data-resource-search-empty]")!.hidden, true);
      counts(2, 1);
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
  console.log("PASS native settings: separate document and legacy display fallback");
}
