import * as assert from "node:assert/strict";
import { App, MarkdownView, Platform, TFile, TFolder, WorkspaceLeaf, openTestModals } from "obsidian";
import CodexForObsidianPlugin from "../main";
import { dailyExpressionFixture, runDailyExpressionTests } from "./english-diary-daily-expression";
import { fingerprint } from "../english-diary/model";
import { EnglishDiaryController } from "../english-diary/controller";
import { EchoInkHomeView } from "../home/home-view";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { DEFAULT_ENGLISH_DIRECTORY, DEFAULT_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_ENGLISH_DIRECTORY, HIDDEN_EXPRESSION_DIRECTORY, LEGACY_ENGLISH_DIRECTORY, LEGACY_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_EXPRESSION_DIRECTORY } from "../english-diary/types";
import { ProductActivityGate } from "../plugin/api-provider-activation-service";
import { PiProviderConfigurationService } from "../plugin/pi-provider-configuration-service";
import {
  activateApiProvider, createApiProviderConfig, DEFAULT_SETTINGS,
  getEnglishDiaryApiProviderModel, normalizeSettingsData
} from "../settings/settings";

export async function runEnglishDiaryProviderTests(installDom: () => void): Promise<void> {
  installDom();
  await assertEnglishDiaryHomeShortcut();
  await assertNativeDiaryPairAndSelection();
  await assertDiaryNestedDirectoryGuard();
  runDailyExpressionTests();
  await assertDailyExpressionHomeCache();
  await assertHomeMissingFolderGuidance();
  const normalized = normalizeSettingsData({ englishDiary: { enabled: true } }).settings.englishDiary;
  assert.equal(normalized.providerSettingsId, "");
  assert.equal(normalized.modelId, "");
  assert.equal(normalized.expressionDirectory, DEFAULT_EXPRESSION_DIRECTORY);
  const oldSettings = structuredClone(DEFAULT_SETTINGS);
  oldSettings.englishDiary.expressionDirectory = LEGACY_EXPRESSION_DIRECTORY;
  oldSettings.englishDiary.providerSettingsId = "kept-provider";
  oldSettings.englishDiary.modelId = "kept-model";
  const migratedSettings = normalizeSettingsData(oldSettings);
  assert.equal(migratedSettings.settings.englishDiary.expressionDirectory, LEGACY_EXPRESSION_DIRECTORY, "normalization preserves the old location for managed-file migration");
  assert.equal(migratedSettings.settings.englishDiary.providerSettingsId, "kept-provider");
  assert.equal(migratedSettings.settings.englishDiary.modelId, "kept-model");
  for (const directory of [HIDDEN_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_EXPRESSION_DIRECTORY, "输出（outputs）/.english-diary/expressions", "My Expressions"]) {
    assert.equal(normalizeSettingsData({ englishDiary: { expressionDirectory: directory } }).settings.englishDiary.expressionDirectory, directory);
  }
  for (const directory of ["../outside", ".other/expressions", ".echoink/english-diary/expressions/../unsafe"]) {
    assert.equal(normalizeSettingsData({ englishDiary: { expressionDirectory: directory } }).settings.englishDiary.expressionDirectory, DEFAULT_EXPRESSION_DIRECTORY);
  }
  for (const directory of [DEFAULT_ENGLISH_DIRECTORY, "输出（outputs）/.english-diary/diaries", "My English Diaries"]) {
    assert.equal(normalizeSettingsData({ englishDiary: { englishDirectory: directory } }).settings.englishDiary.englishDirectory, directory);
  }
  for (const directory of ["outputs/.private/diaries", "outputs/.english-diary/diaries/../private", "/outputs/.english-diary/diaries"]) {
    assert.equal(normalizeSettingsData({ englishDiary: { englishDirectory: directory } }).settings.englishDiary.englishDirectory, DEFAULT_ENGLISH_DIRECTORY);
  }
  const legacyNormalized = normalizeSettingsData({ englishDiary: {
    legacyEnglishDirectories: [" My Diaries/ ", "My Diaries", "../outside", null, "Old outputs/.english-diary/diaries"],
    legacyExpressionDirectories: [LEGACY_HIDDEN_EXPRESSION_DIRECTORY, "My Expressions", ".other/expressions"]
  } }).settings.englishDiary;
  assert.deepEqual(legacyNormalized.legacyEnglishDirectories, ["My Diaries", "Old outputs/.english-diary/diaries"]);
  assert.deepEqual(legacyNormalized.legacyExpressionDirectories, [LEGACY_HIDDEN_EXPRESSION_DIRECTORY, "My Expressions"]);
  for (const roots of [[], ["outputs"], ["输出（outputs）"], ["outputs", "输出（outputs）"]]) {
    const storage = normalizeSettingsData({ englishDiary: { englishDirectory: "Old English", expressionDirectory: "Old Expressions" } }).settings;
    const plugin = {
      settings: storage, manifest: { id: "echoink-test" },
      app: { vault: { configDir: ".test-config", getRoot: () => ({ children: roots.map((name) => Object.assign(new TFolder(), { name, path: name })) }) } }
    };
    new EnglishDiaryController(plugin as never);
    assert.equal(storage.englishDiary.englishDirectory, "Old English", "custom English directories are preserved");
    assert.equal(storage.englishDiary.expressionDirectory, "Old Expressions", "custom expression directories are preserved");
    assert.equal(storage.englishDiary.englishDirectoryMode, "custom");
    assert.equal(storage.englishDiary.expressionDirectoryMode, "custom");
    for (const directory of [DEFAULT_ENGLISH_DIRECTORY, LEGACY_ENGLISH_DIRECTORY])
      assert.ok(storage.englishDiary.legacyEnglishDirectories?.includes(directory), `migration retains English source ${directory}`);
    for (const directory of [HIDDEN_EXPRESSION_DIRECTORY, LEGACY_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_EXPRESSION_DIRECTORY])
      assert.ok(storage.englishDiary.legacyExpressionDirectories?.includes(directory), `migration retains expression source ${directory}`);
    assert.ok(!storage.englishDiary.legacyEnglishDirectories?.includes(storage.englishDiary.englishDirectory), "the current English target is not a legacy source");
    assert.ok(!storage.englishDiary.legacyExpressionDirectories?.includes(storage.englishDiary.expressionDirectory), "the current expression target is not a legacy source");
    const restored = normalizeSettingsData(JSON.parse(JSON.stringify(storage))).settings;
    assert.deepEqual(restored.englishDiary, storage.englishDiary, "resolved hidden paths and migration roots survive saving and reopening");
    new EnglishDiaryController({ ...plugin, settings: restored } as never);
    assert.deepEqual(restored.englishDiary, storage.englishDiary, "reopening does not duplicate old roots");

    const defaults = normalizeSettingsData({}).settings;
    new EnglishDiaryController({ ...plugin, settings: defaults } as never);
    const root = roots.includes("outputs") ? "outputs" : "输出（outputs）";
    assert.equal(defaults.englishDiary.englishDirectory, `${root}/英文日记`, "default English directories still follow the output root");
    assert.equal(defaults.englishDiary.expressionDirectory, `${root}/英文日记/表达库`);
    assert.equal(defaults.englishDiary.englishDirectoryMode, "role");
    assert.equal(defaults.englishDiary.expressionDirectoryMode, "role");
  }
  console.log("PASS English Diary storage: custom directories preserved, default directories migrated, reopen idempotent");
  const rebuiltSettings = normalizeSettingsData({}).settings;
  new EnglishDiaryController({
    settings: rebuiltSettings, manifest: { id: "echoink-test" },
    app: { vault: { configDir: ".test-config", getRoot: () => ({ children: [Object.assign(new TFolder(), { name: "输出（outputs）", path: "输出（outputs）" })] }) } }
  } as never);
  assert.equal(rebuiltSettings.englishDiary.englishDirectory, "输出（outputs）/英文日记");
  assert.equal(rebuiltSettings.englishDiary.expressionDirectory, "输出（outputs）/英文日记/表达库");
  for (const directory of [LEGACY_ENGLISH_DIRECTORY, DEFAULT_ENGLISH_DIRECTORY])
    assert.ok(rebuiltSettings.englishDiary.legacyEnglishDirectories?.includes(directory), "rebuilt settings retain known English migration sources without old configuration");
  for (const directory of [LEGACY_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_EXPRESSION_DIRECTORY, HIDDEN_EXPRESSION_DIRECTORY])
    assert.ok(rebuiltSettings.englishDiary.legacyExpressionDirectories?.includes(directory), "rebuilt settings retain known expression migration sources without old configuration");
  const trimmed = normalizeSettingsData({ englishDiary: {
    providerSettingsId: " diary-provider ", modelId: " diary-model "
  } }).settings.englishDiary;
  assert.equal(trimmed.providerSettingsId, "diary-provider");
  assert.equal(trimmed.modelId, "diary-model");

  const settings = structuredClone(DEFAULT_SETTINGS);
  const global = createApiProviderConfig("deepseek", "global-provider");
  const diary = createApiProviderConfig("deepseek", "diary-provider");
  global.apiKey = "fixture-global-key";
  diary.apiKey = "fixture-diary-key";
  diary.name = "Diary Provider";
  settings.apiProviders = [global, diary];
  activateApiProvider(settings, global);
  settings.englishDiary.enabled = true;
  assert.equal(getEnglishDiaryApiProviderModel(settings).provider, global);

  const plugin: any = Object.create(CodexForObsidianPlugin.prototype);
  let paid = true;
  Object.assign(plugin, { app: new App(), settings,
    accountService: { checkCapability: () => paid, requireCapability: () => { if (!paid) throw new Error("PRO_REQUIRED"); }, subscribe: () => () => {} },
    productActivity: new ProductActivityGate(), piRunConversations: new Map(), piSubmittingConversations: new Set() });
  let saved: unknown = null, saves = 0, failSave = false;
  plugin.saveSettings = async () => {
    saves++;
    if (failSave) throw new Error("fixture save failed");
    saved = structuredClone(settings.englishDiary);
  };
  plugin.cancelAllPiConversationActivations = () => { throw new Error("must not cancel chat"); };
  await plugin.setEnglishDiaryModel(diary.id, diary.defaultModelId);
  assert.equal(getEnglishDiaryApiProviderModel(settings).provider, diary, "Provider record id scopes model identity");
  assert.equal(settings.activeApiProviderId, global.id);
  assert.equal(settings.defaultModel, global.defaultModelId);
  assert.deepEqual(saved, settings.englishDiary);
  assert.equal(plugin.englishDiaryProviderLabel(), `${diary.name} · ${diary.defaultModelId}`);

  settings.englishDiary.approvedProvider = "previous-approval";
  failSave = true;
  await assert.rejects(plugin.setEnglishDiaryModel("", ""), /未保存/u);
  assert.equal(settings.englishDiary.providerSettingsId, diary.id);
  assert.equal(settings.englishDiary.approvedProvider, "previous-approval");
  failSave = false;
  await plugin.productActivity.run(async () => {
    await assert.rejects(plugin.setEnglishDiaryModel("", ""), /暂时不能切换/u);
  });
  const savesBeforeInvalid = saves;
  await assert.rejects(plugin.setEnglishDiaryModel("missing-provider", diary.defaultModelId), /Provider 已不存在/u);
  await assert.rejects(plugin.setEnglishDiaryModel(diary.id, "missing-model"), /模型已不存在/u);
  await assert.rejects(plugin.setEnglishDiaryModel(diary.id, ""), /配置不完整/u);
  assert.equal(saves, savesBeforeInvalid);

  const requests: any[] = [];
  const service = new PiProviderConfigurationService(plugin, {
    textGenerationDispatcher: { stream(request: any) {
      requests.push(request);
      return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "fixture English" }] }) };
    } } as never
  });
  plugin.getPiProviderConfigurationService = () => service;
  const input = () => ({ systemPrompt: "fixture system", userPrompt: "fixture diary", signal: new AbortController().signal });
  function decide(accept: boolean): string {
    const modal = openTestModals.at(-1);
    assert.ok(modal, "a changed recipient requires confirmation before sending");
    const text = modal.contentEl.textContent ?? "";
    const button = Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((element) => element.textContent === (accept ? "确认并继续" : "取消"));
    assert.ok(button);
    button.click();
    return text;
  }
  const first = plugin.generateEnglishDiaryText(input());
  assert.equal(requests.length, 0);
  const confirmation = decide(true);
  assert.match(confirmation, /Diary Provider/u);
  assert.ok(confirmation.includes(new URL(diary.baseUrl).origin));
  assert.doesNotMatch(confirmation, /整理想法|表达追问/u);
  assert.equal(await first, "fixture English");
  assert.equal(requests[0].apiKey, diary.apiKey, "the existing service resolves the selected saved Key");
  assert.equal(requests[0].model.id, diary.defaultModelId);
  assert.equal(settings.activeApiProviderId, global.id);
  assert.equal(await plugin.generateEnglishDiaryText(input()), "fixture English");
  assert.equal(openTestModals.length, 0, "unchanged approved selection does not prompt again");

  diary.baseUrl = "https://diary-provider.example/v1";
  const changedRecipient = plugin.generateEnglishDiaryText(input());
  assert.ok(decide(false).includes("https://diary-provider.example"));
  await assert.rejects(changedRecipient, /未发送/u);
  assert.equal(requests.length, 2);

  const cancelled = new AbortController();
  const normalSave = plugin.saveSettings;
  plugin.saveSettings = async () => { await normalSave(); cancelled.abort(); };
  const lateCancellation = plugin.generateEnglishDiaryText({ ...input(), signal: cancelled.signal });
  decide(true);
  await assert.rejects(lateCancellation, /未发送/u);
  assert.equal(requests.length, 2, "cancel during confirmation persistence never sends");
  plugin.saveSettings = normalSave;

  settings.englishDiary.approvedProvider = "";
  const expiredDuringConsent = plugin.generateEnglishDiaryText(input());
  paid = false; decide(true);
  await assert.rejects(expiredDuringConsent, /PRO_REQUIRED/);
  assert.equal(requests.length, 2, "expiry during consent never starts a generation");
  assert.equal(settings.englishDiary.approvedProvider, "", "denied consent does not persist approval");
  await assert.rejects(plugin.generateEnglishDiaryText(input()), /PRO_REQUIRED/);
  paid = true;

  plugin.saveSettings = async () => { await normalSave(); paid = false; };
  const expiredDuringSave = plugin.generateEnglishDiaryText(input()); decide(true);
  await assert.rejects(expiredDuringSave, /PRO_REQUIRED/);
  assert.equal(requests.length, 2, "expiry during approval save never starts a generation");
  plugin.saveSettings = normalSave; paid = true;

  diary.apiKey = "";
  await assert.rejects(plugin.generateEnglishDiaryText(input()), /缺少 API Key/u);
  settings.apiProviders = [global];
  assert.match(plugin.englishDiaryProviderLabel(), /Provider 已不存在/u);
  await assert.rejects(plugin.generateEnglishDiaryText(input()), /Provider 已不存在/u);
  assert.equal(requests.length, 2, "removed selection never falls back to another recipient");
  await plugin.setEnglishDiaryModel("", "");
  assert.equal(settings.englishDiary.approvedProvider, "");
  assert.equal(getEnglishDiaryApiProviderModel(settings).provider, global);
  settings.activeApiProviderId = "";
  assert.match(plugin.englishDiaryProviderLabel(), /尚未设置默认模型/u);
}

async function assertHomeMissingFolderGuidance(): Promise<void> {
  const makeFixture = () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.knowledgeBase.folderBindings = emptyKnowledgeFolderBindings();
    const events: string[] = [];
    const folders = new Map<string, TFolder>();
    const dailyOptions: Record<string, unknown> = {};
    const app = Object.assign(new App(), {
      vault: {
        getRoot: () => ({ children: [...folders.values()] }),
        getAbstractFileByPath: (path: string) => folders.get(path) ?? null
      },
      internalPlugins: { plugins: { "daily-notes": { instance: { options: dailyOptions } } } },
      workspace: {
        getLeaf: () => ({ openFile: async () => { events.push("open-note"); } }),
        setActiveLeaf: () => {}
      }
    });
    const plugin = {
      settings, app,
      openEchoInkKnowledgeSettings: async () => { events.push("choose-location"); },
      requireAvailableEchoInkSkill: async () => { events.push("require-skill"); },
      activateView: async () => { events.push("open-chat"); },
      getCodexView: () => ({ startHomeConversation: async () => { events.push("start-journal"); } })
    };
    const home = Object.assign(Object.create(EchoInkHomeView.prototype), {
      plugin, app, closed: false, captureBusy: false,
      dataService: {
        createBlankInboxNote: async () => { events.push("create-note"); return { path: "随手记/未命名.md" }; },
        listCustomTemplates: () => { events.push("list-templates"); return []; }
      },
      refresh: async () => {}
    }) as {
      capture(): Promise<void>;
      openConversationAction(action: "daily"): Promise<void>;
      openJournalTemplate(date: Date): Promise<void>;
    };
    return { settings, events, folders, dailyOptions, plugin, home };
  };
  const chooseLocation = (title: string) => {
    const modal = openTestModals.at(-1);
    assert.ok(modal, "missing locations show actionable guidance");
    assert.equal(modal.contentEl.querySelector("h2")?.textContent, title);
    assert.match(modal.contentEl.querySelector("p")?.textContent ?? "", /位置/u);
    const buttons = [...modal.contentEl.querySelectorAll<HTMLButtonElement>("button")];
    assert.deepEqual(buttons.map((button) => button.textContent), ["稍后", "去选择位置"]);
    buttons.at(-1)!.click();
  };
  assert.equal(openTestModals.length, 0);
  for (const state of ["disabled", "unbound", "missing"] as const) {
    const fixture = makeFixture();
    const binding = fixture.settings.knowledgeBase.folderBindings!.roles.inbox;
    binding.enabled = state !== "disabled";
    binding.writePath = state === "missing" ? "已删除的收件箱" : null;
    const capture = fixture.home.capture();
    assert.deepEqual(fixture.events, [], "guidance does not create a note or a directory");
    await fixture.home.capture();
    assert.equal(openTestModals.length, 1, "repeated capture does not stack dialogs");
    chooseLocation("选择收件箱位置");
    await capture;
    assert.deepEqual(fixture.events, ["choose-location"]);
    assert.equal(binding.enabled, state !== "disabled", "guidance leaves migration settings unchanged");
  }
  const cancelled = makeFixture();
  const pending = cancelled.home.capture();
  openTestModals.at(-1)!.close();
  await pending;
  assert.deepEqual(cancelled.events, [], "closing guidance leaves settings and notes unchanged");
  const binding = cancelled.settings.knowledgeBase.folderBindings!.roles.inbox;
  Object.assign(binding, { enabled: true, writePath: "随手记", readPaths: ["随手记"] });
  cancelled.folders.set("随手记", Object.assign(new TFolder(), { path: "随手记" }));
  await cancelled.home.capture();
  assert.deepEqual(cancelled.events, ["create-note", "open-note"], "retry works after a folder is chosen");

  for (const action of ["chat", "template", "english-shortcut"] as const) {
    const fixture = makeFixture();
    if (action === "english-shortcut") {
      fixture.settings.englishDiary.homeShortcut = "english-diary";
      Object.assign(fixture.plugin, {
        accountService: { checkCapability: () => true },
        englishDiary: { enabled: () => true, openToday: async () => { fixture.events.push("open-english"); } }
      });
    }
    const pending = action === "chat" ? fixture.home.openConversationAction("daily")
      : action === "template" ? fixture.home.openJournalTemplate(new Date()) : fixture.home.capture();
    assert.deepEqual(fixture.events, [], "missing journal location is handled before opening chat or creating content");
    chooseLocation("选择日记位置");
    await pending;
    assert.deepEqual(fixture.events, ["choose-location"]);
  }
  for (const folder of ["", "我的原生日记"]) {
    const fixture = makeFixture();
    fixture.dailyOptions.folder = folder;
    await fixture.home.openConversationAction("daily");
    assert.equal(openTestModals.length, 0, "native Daily notes configuration remains authoritative, including the vault root");
    assert.deepEqual(fixture.events, ["require-skill", "open-chat", "start-journal"]);
  }
  const readonlyDiary = makeFixture();
  readonlyDiary.settings.englishDiary.homeShortcut = "english-diary";
  Object.assign(readonlyDiary.plugin, { englishDiary: { enabled: () => true, openToday: async () => { readonlyDiary.events.push("open-library"); } } });
  await readonlyDiary.home.capture();
  assert.equal(openTestModals.length, 0);
  assert.deepEqual(readonlyDiary.events, ["open-library"], "read-only English diary access does not require a creation location");
  console.log("PASS Home missing folder guidance: inbox and journal choices, cancellation, retry and native Daily notes precedence");
}

async function assertEnglishDiaryHomeShortcut(): Promise<void> {
  type Choice = "quick-record" | "english-diary";
  assert.equal(DEFAULT_SETTINGS.englishDiary.homeShortcut, "ask");
  for (const homeShortcut of [undefined, null, "", "unknown", 1, true, {}]) {
    assert.equal(normalizeSettingsData({ englishDiary: { homeShortcut } }).settings.englishDiary.homeShortcut, "ask", "missing or invalid shortcuts require an explicit first choice");
  }
  for (const homeShortcut of ["ask", "quick-record", "english-diary"] as const) {
    assert.equal(normalizeSettingsData({ englishDiary: { homeShortcut } }).settings.englishDiary.homeShortcut, homeShortcut);
  }
  const makeFixture = (enabled: boolean, homeShortcut: "ask" | Choice) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    Object.assign(settings.englishDiary, { enabled, homeShortcut });
    const events: string[] = [];
    const saving = { fail: false, pending: null as Promise<void> | null };
    const app = Object.assign(new App(), { workspace: {
      getLeaf: () => ({ openFile: async () => { events.push("open-inbox"); } }),
      setActiveLeaf: () => { events.push("focus-inbox"); }
    } });
    const plugin = {
      app, settings, englishDiary: null as EnglishDiaryController | null,
      saveSettings: async () => {
        events.push(`save:${settings.englishDiary.homeShortcut}`);
        await saving.pending;
        if (saving.fail) throw new Error("shortcut save failed");
        events.push("saved");
      },
      notifyHomeSurfacesChanged: () => { events.push("notify-home"); }
    };
    const controller = Object.create(EnglishDiaryController.prototype) as EnglishDiaryController;
    Object.assign(controller, { plugin, openToday: async () => { events.push("open-diary"); } });
    plugin.englishDiary = controller;
    const home = Object.assign(Object.create(EchoInkHomeView.prototype), {
      plugin, app, closed: false, captureBusy: false, shortcutChoiceAbort: null,
      contentEl: document.createElement("div"),
      dataService: { createBlankInboxNote: async () => { events.push("quick-record"); return { path: "inbox/shortcut.md" }; } },
      refresh: async () => { events.push("refresh-home"); },
      renderFinanceCard() {}, applyModuleVisibility() {}, renderTodos() {}
    }) as { capture(): Promise<void>; refreshHomeSurfaces(): void; captureBusy: boolean };
    return { settings, events, saving, plugin, controller, home };
  };
  const quickRecord = ["quick-record", "open-inbox", "focus-inbox", "refresh-home"];
  const choose = (choice: Choice) => {
    const modal = openTestModals.at(-1);
    assert.ok(modal, "first use shows an explicit choice");
    const button = modal.contentEl.querySelector<HTMLButtonElement>(`[data-home-shortcut-choice="${choice}"]`);
    assert.ok(button, `choice ${choice} is available`);
    button.click();
  };
  assert.equal(openTestModals.length, 0);

  const controller = makeFixture(true, "ask");
  const before = structuredClone(controller.settings.englishDiary);
  await controller.controller.setHomeShortcut("english-diary");
  assert.deepEqual(controller.events, ["save:english-diary", "saved", "notify-home"], "home is notified only after shortcut persistence succeeds");
  assert.deepEqual(controller.settings.englishDiary, { ...before, homeShortcut: "english-diary" }, "shortcut saving leaves other diary settings untouched");
  controller.events.length = 0; controller.saving.fail = true;
  await assert.rejects(controller.controller.setHomeShortcut("quick-record"), /shortcut save failed/u);
  assert.equal(controller.settings.englishDiary.homeShortcut, "english-diary", "failed save restores the prior choice");
  assert.deepEqual(controller.events, ["save:quick-record"], "failed persistence does not notify home");

  for (const choice of ["ask", "english-diary"] as const) {
    const disabled = makeFixture(false, choice);
    await disabled.home.capture();
    assert.deepEqual(disabled.events, quickRecord, "disabled diary preserves the original quick-record flow");
    assert.equal(disabled.settings.englishDiary.homeShortcut, choice);
    assert.equal(openTestModals.length, 0);
  }
  const cancelled = makeFixture(true, "ask");
  const cancellation = cancelled.home.capture();
  assert.equal(openTestModals.length, 1);
  await cancelled.home.capture();
  assert.equal(openTestModals.length, 1, "repeated capture cannot open another choice dialog");
  assert.deepEqual(cancelled.events, [], "showing a choice does not create content or save preferences");
  openTestModals.at(-1)!.close(); await cancellation;
  assert.deepEqual(cancelled.events, []);
  assert.equal(cancelled.settings.englishDiary.homeShortcut, "ask", "cancel preserves first-use choice state");
  assert.equal(cancelled.home.captureBusy, false);

  for (const choice of ["quick-record", "english-diary"] as const) {
    const selected = makeFixture(true, "ask");
    const capture = selected.home.capture(); choose(choice); await capture;
    const entry = choice === "english-diary" ? ["open-diary"] : quickRecord;
    assert.deepEqual(selected.events, [`save:${choice}`, "saved", "notify-home", ...entry], "selected entry opens only after successful preference saving");
    assert.equal(selected.settings.englishDiary.homeShortcut, choice);
    selected.events.length = 0;
    await selected.home.capture();
    assert.deepEqual(selected.events, entry, "remembered choice opens directly without saving again");
    assert.equal(openTestModals.length, 0, "remembered choice does not ask again");
    selected.events.length = 0; selected.settings.englishDiary.enabled = false;
    await selected.home.capture();
    assert.deepEqual(selected.events, quickRecord, "disabling the plugin returns Home to quick record");
  }

  const failed = makeFixture(true, "ask");
  failed.saving.fail = true;
  const failure = failed.home.capture(); choose("english-diary");
  await assert.rejects(failure, /shortcut save failed/u);
  assert.deepEqual(failed.events, ["save:english-diary"], "failed preference saving must not open either entry");
  assert.equal(failed.settings.englishDiary.homeShortcut, "ask");
  assert.equal(failed.home.captureBusy, false, "failed saving permits a later retry");
  failed.events.length = 0; failed.saving.fail = false;
  const retry = failed.home.capture(); choose("quick-record"); await retry;
  assert.deepEqual(failed.events, ["save:quick-record", "saved", "notify-home", ...quickRecord]);

  const pending = makeFixture(true, "ask");
  let finishSave!: () => void;
  pending.saving.pending = new Promise<void>((resolve) => { finishSave = resolve; });
  const waitForSave = pending.home.capture(); choose("english-diary");
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(pending.events, ["save:english-diary"], "entry waits for the pending save");
  await pending.home.capture();
  assert.deepEqual(pending.events, ["save:english-diary"], "repeated capture during saving does not bypass persistence");
  finishSave(); await waitForSave;
  assert.deepEqual(pending.events, ["save:english-diary", "saved", "notify-home", "open-diary"]);

  const stopped = makeFixture(true, "ask");
  const stoppedChoice = stopped.home.capture();
  stopped.settings.englishDiary.enabled = false;
  stopped.home.refreshHomeSurfaces(); await stoppedChoice;
  assert.equal(openTestModals.length, 0, "disabling while choosing dismisses the stale dialog");
  assert.deepEqual(stopped.events, [], "a disabled pending choice does not save or open content");
  assert.equal(stopped.settings.englishDiary.homeShortcut, "ask");
  await stopped.home.capture();
  assert.deepEqual(stopped.events, quickRecord);
  console.log("PASS English Diary Home shortcut: normalization, save rollback, first-choice cancellation, remembered routing and disabled fallback");
}


async function assertNativeDiaryPairAndSelection(): Promise<void> {
  const sourcePath = "journal/native.md", content = "I 鼓起勇气 today.";
  const file = Object.assign(new TFile(), { path: sourcePath, extension: "md", basename: "native" });
  const leaves: any[] = [], splits: Array<{ beside: any; before?: boolean }> = [];
  let editorContent = content, selections = 0, modeChanges = 0;
  const makeLeaf = () => {
    const leaf: any = { state: {}, view: { getState: () => leaf.state.state ?? {} },
      setViewState: async (state: any) => { leaf.state = state; },
      openFile: async () => {
        leaf.state = { type: "markdown", state: { file: sourcePath } };
        leaf.view = Object.assign(Object.create(MarkdownView.prototype), {
          file, mode: "source", getState: () => ({ file: sourcePath, mode: leaf.view.mode }), getMode: () => leaf.view.mode,
          setState: async (state: { mode: string }) => { leaf.view.mode = state.mode; modeChanges++; },
          editor: { getValue: () => editorContent, offsetToPos: (ch: number) => ({ line: 0, ch }),
            setSelections: () => { selections++; }, scrollIntoView() {}, focus() {} }
        });
      }
    };
    leaves.push(leaf); return leaf;
  };
  const settings = normalizeSettingsData({ englishDiary: { enabled: true } }).settings;
  const plugin: any = { settings, manifest: { id: "test" }, app: {
    vault: { configDir: ".obsidian", getRoot: () => ({ children: [] }), getAbstractFileByPath: () => file },
    workspace: { getLeavesOfType: (type: string) => leaves.filter((leaf) => leaf.state.type === type),
      getLeaf: () => makeLeaf(), createLeafBySplit: (beside: any, _direction: string, before?: boolean) => {
        splits.push({ beside, before }); return makeLeaf();
      }, revealLeaf: async () => {} }
  } };
  const controller = new EnglishDiaryController(plugin);
  await controller.openDiary(sourcePath);
  assert.equal(leaves.length, 2, "native original and English each own one leaf");
  assert.equal(splits.length, 1);
  await controller.openDiary(sourcePath);
  assert.equal(leaves.length, 2, "reopen reuses both tabs without rearranging");
  assert.equal(modeChanges, 0, "an editing source is not reset during reopen");
  const originalLeaf = leaves.find((leaf) => leaf.state.type === "markdown");
  originalLeaf.view.mode = "preview";
  await controller.openDiary(sourcePath);
  assert.equal(originalLeaf.view.getMode(), "source", "a reused preview becomes directly editable");
  assert.equal(modeChanges, 1);
  assert.equal(leaves.length, 2);
  assert.equal(splits.length, 1, "switching the original to edit mode leaves the split layout intact");
  assert.equal(originalLeaf.view.editor.getValue(), content, "mode switching preserves the current source buffer");
  const range = { start: 2, end: 6, text: "鼓起勇气" };
  await controller.focusSource(sourcePath, [range], { expectedFingerprint: fingerprint(content) });
  assert.equal(selections, 1);
  editorContent += " changed";
  await controller.focusSource(sourcePath, [range], { expectedFingerprint: fingerprint(content) });
  assert.equal(selections, 1, "late source edits never select stale offsets");
  await controller.focusSource(sourcePath, [{ ...range, text: "wrong" }], { expectedFingerprint: fingerprint(editorContent) });
  assert.equal(selections, 1, "matching fingerprint alone cannot validate a forged excerpt");
  const panel = leaves.find((leaf) => leaf.state.type === "echoink-english-diary");
  leaves.splice(leaves.findIndex((leaf) => leaf.state.type === "markdown"), 1);
  await controller.openDiary(sourcePath);
  assert.equal(splits.at(-1)?.beside, panel);
  assert.equal(splits.at(-1)?.before, true, "a missing original is restored to the left only");
  await controller.openLibrary("selected-expression");
  assert.equal(leaves.at(-1).state.state.expressionId, "selected-expression");
  (Platform as any).isMobile = true;
  try { await assert.rejects(controller.generate(sourcePath, { force: true }), /电脑/u); }
  finally { delete (Platform as any).isMobile; }
  const record: any = { englishModified: true, result: { sourceFingerprint: fingerprint(content) }, observedFileFingerprint: "manual-current" };
  let publishedOptions: any = null;
  Object.assign(controller.api, { readSource: async () => ({ content }), load: async () => record,
    generate: async (_path: string, options: any) => { publishedOptions = options; return record; } });
  const forced = controller.generate(sourcePath, { force: true });
  for (let i = 0; i < 10 && !openTestModals.length; i++) await Promise.resolve();
  const confirmation = openTestModals.at(-1)!;
  assert.ok(confirmation, "same-source force still confirms a manually edited English file");
  confirmation.contentEl.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { if (button.textContent === "确认替换") button.click(); });
  await forced;
  assert.equal(publishedOptions.force, true);
  assert.equal(publishedOptions.overwriteModified, true);
  assert.equal(publishedOptions.expectedEnglishFingerprint, "manual-current");
  console.log("PASS English Diary native pair reuse, guarded selection and desktop generation");
}

async function assertDiaryNestedDirectoryGuard(): Promise<void> {
  const settings = normalizeSettingsData({ englishDiary: { enabled: true, englishDirectoryMode: "role", expressionDirectoryMode: "role" } }).settings;
  const bindings = emptyKnowledgeFolderBindings();
  settings.knowledgeBase.folderBindings = bindings;
  Object.assign(bindings.roles.outputs, { enabled: true, readPaths: ["My outputs"], writePath: "My outputs", allowedSubdirectories: ["英文日记", "英文日记/表达库"] });
  const folders = new Map(["My outputs"].map((path) => [path, Object.assign(new TFolder(), { path })]));
  const plugin: any = { settings, manifest: { id: "test" }, getVaultPath: () => "/__english_diary_fixture__", app: { vault: {
    configDir: ".obsidian", getRoot: () => ({ children: [] }), getAbstractFileByPath: (path: string) => folders.get(path) ?? null
  } } };
  const inferred = normalizeSettingsData({ knowledgeBase: { folderBindings: bindings }, englishDiary: {
    englishDirectory: "My outputs/.english-diary/diaries", expressionDirectory: "My outputs/表达库"
  } }).settings;
  assert.equal(inferred.englishDiary.englishDirectoryMode, "role", "an old bound hidden default remains recognizable");
  assert.equal(inferred.englishDiary.englishDirectory, "My outputs/.english-diary/diaries", "normalization preserves the real hidden source for migration");
  assert.equal(inferred.englishDiary.expressionDirectoryMode, "role", "an old bound flat default remains recognizable");
  const custom = normalizeSettingsData({ knowledgeBase: { folderBindings: bindings }, englishDiary: {
    englishDirectoryMode: "custom", englishDirectory: "My outputs/英文日记", expressionDirectoryMode: "custom", expressionDirectory: "My outputs/表达库"
  } }).settings;
  assert.equal(custom.englishDiary.expressionDirectoryMode, "custom", "an explicit custom choice always wins");
  const controller = new EnglishDiaryController(plugin);
  const guard = (controller.api.repository as any).files.beforeWrite as (path: string, exists: boolean) => void;
  assert.equal(settings.englishDiary.expressionDirectory, "My outputs/英文日记/表达库");
  assert.ok(settings.englishDiary.legacyExpressionDirectories?.includes("My outputs/表达库"));
  assert.ok(settings.englishDiary.legacyEnglishDirectories?.includes("My outputs/.english-diary/diaries"));
  assert.ok(settings.englishDiary.legacyExpressionDirectories?.includes("My outputs/.english-diary/expressions"));
  const canMigrate = (controller.api.repository as any).options.canMigrate as () => boolean;
  assert.equal(canMigrate(), true, "both approved target directories permit migration");
  assert.doesNotThrow(() => guard("My outputs/英文日记/表达库/word.md", false));
  bindings.roles.outputs.allowedSubdirectories = ["英文日记", "表达库"];
  assert.equal(canMigrate(), false, "old sibling approvals defer migration to the unapproved nested directory");
  assert.deepEqual(bindings.roles.outputs.allowedSubdirectories, ["英文日记", "表达库"], "reading migration permission does not expand approvals");
  folders.set("My outputs/英文日记/表达库", Object.assign(new TFolder(), { path: "My outputs/英文日记/表达库" }));
  assert.equal(canMigrate(), true, "an existing target folder needs no new creation approval");
  folders.delete("My outputs/英文日记/表达库");
  assert.throws(() => guard("My outputs/英文日记/表达库/word.md", false), /英文日记\/表达库/u, "the outer diary approval cannot hide the deeper required approval");
  bindings.roles.outputs.enabled = false;
  assert.equal(canMigrate(), false, "a disabled output defers migration even if old files are present");
  assert.throws(() => guard("My outputs/英文日记/new.md", false), /可用的输出位置/u);
  assert.doesNotThrow(() => guard("My outputs/英文日记/old.md", true), "existing assets remain editable");
  bindings.roles.outputs.enabled = true;
  bindings.roles.outputs.allowedSubdirectories = ["英文日记", "英文日记/表达库"];
  assert.equal(canMigrate(), true, "the same repository sees a later explicit nested-directory approval");
  bindings.roles.outputs.allowedSubdirectoryRoots = ["Another output"];
  assert.equal(canMigrate(), false, "approval belongs to the exact output root");
  bindings.roles.outputs.allowedSubdirectoryRoots = ["My outputs"];
  assert.equal(canMigrate(), true);
  bindings.roles.outputs.writePath = "New outputs";
  bindings.roles.outputs.readPaths = ["New outputs"];
  controller.refreshStoragePaths();
  assert.equal(settings.englishDiary.expressionDirectory, "New outputs/英文日记/表达库");
  assert.equal(canMigrate(), false, "a missing replacement output root cannot be created by migration");
  assert.ok(settings.englishDiary.legacyExpressionDirectories?.includes("My outputs/英文日记/表达库"), "role changes retain real old paths");
  console.log("PASS English Diary nested output approvals and disabled-output protection");
}


async function assertDailyExpressionHomeCache(): Promise<void> {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.englishDiary.enabled = true;
  let listener: (() => void) | undefined, reads = 0, active = true, selected = "";
  let entries = [dailyExpressionFixture("daily")];
  const repository = { subscribe: (next: () => void) => { listener = next; return () => { listener = undefined; }; },
    listExpressions: async () => { reads++; return entries; } };
  const contentEl = document.createElement("div");
  const footer = contentEl.createEl("footer", { cls: "page-footer" });
  footer.insertAdjacentElement = (_position, card) => contentEl.insertBefore(card, footer);
  const home: any = Object.assign(Object.create(EchoInkHomeView.prototype), {
    plugin: { settings, englishDiary: { api: { repository }, openLibrary: async (id: string) => { selected = id; } } },
    contentEl, closed: false, foreground: { isActive: () => active }, dailyRepository: null, dailyUnsubscribe: null,
    dailyEntries: null, dailyLoad: null, dailyVersion: 0, dailyTimer: null
  });
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  try {
    home.renderDailyExpression();
    assert.equal(contentEl.querySelector(".echoink-life-card-english"), null, "first paint does not wait for the repository");
    await settle();
    assert.equal(reads, 1);
    assert.match(contentEl.textContent ?? "", /expression daily/u, "existing assets render with no PRO access object");
    home.renderDailyExpression(); home.renderDailyExpression();
    assert.equal(reads, 1, "normal home refreshes reuse the expression cache");
    contentEl.querySelector(".echoink-life-card-english")!.querySelector<HTMLButtonElement>("button")!.click();
    await settle(); assert.equal(selected, "daily", "view expression goes straight to the selected entry");
    active = false; entries = []; listener?.(); await settle();
    assert.equal(reads, 1, "background changes only invalidate the cache");
    active = true; home.renderDailyExpression(); await settle();
    assert.equal(reads, 2);
    assert.equal(contentEl.querySelector(".echoink-life-card-english"), null, "deleting the last valid occurrence removes the card");
    entries = [dailyExpressionFixture("again")]; listener?.(); await settle();
    assert.ok(contentEl.querySelector(".echoink-life-card-english"));
    settings.englishDiary.enabled = false; home.renderDailyExpression();
    assert.equal(contentEl.querySelector(".echoink-life-card-english"), null);
    settings.englishDiary.enabled = true;
    let resolve!: (value: typeof entries) => void;
    repository.listExpressions = () => { reads++; return new Promise((done) => { resolve = done; }); };
    listener?.(); await settle();
    listener?.(); home.closed = true; home.dailyVersion++;
    resolve(entries); await settle();
    assert.equal(contentEl.querySelector(".echoink-life-card-english"), null, "closed home cannot receive a late repository response");
  } finally { home.closed = true; home.clearDailyTimer(); home.dailyUnsubscribe?.(); }
  console.log("PASS English Diary daily expression rotation, cached list and home lifecycle");
}
