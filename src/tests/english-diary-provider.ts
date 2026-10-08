import * as assert from "node:assert/strict";
import { App, TFolder, openTestModals } from "obsidian";
import CodexForObsidianPlugin from "../main";
import { EnglishDiaryController } from "../english-diary/controller";
import { EchoInkHomeView } from "../home/home-view";
import { DEFAULT_ENGLISH_DIRECTORY, HIDDEN_EXPRESSION_DIRECTORY, LEGACY_ENGLISH_DIRECTORY, LEGACY_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_EXPRESSION_DIRECTORY } from "../english-diary/types";
import { ProductActivityGate } from "../plugin/api-provider-activation-service";
import { PiProviderConfigurationService } from "../plugin/pi-provider-configuration-service";
import {
  activateApiProvider, createApiProviderConfig, DEFAULT_SETTINGS,
  getEnglishDiaryApiProviderModel, normalizeSettingsData
} from "../settings/settings";

export async function runEnglishDiaryProviderTests(installDom: () => void): Promise<void> {
  installDom();
  await assertEnglishDiaryHomeShortcut();
  const normalized = normalizeSettingsData({ englishDiary: { enabled: true } }).settings.englishDiary;
  assert.equal(normalized.providerSettingsId, "");
  assert.equal(normalized.modelId, "");
  assert.equal(normalized.expressionDirectory, HIDDEN_EXPRESSION_DIRECTORY);
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
    assert.equal(normalizeSettingsData({ englishDiary: { expressionDirectory: directory } }).settings.englishDiary.expressionDirectory, HIDDEN_EXPRESSION_DIRECTORY);
  }
  for (const directory of [DEFAULT_ENGLISH_DIRECTORY, "输出（outputs）/.english-diary/diaries", "My English Diaries"]) {
    assert.equal(normalizeSettingsData({ englishDiary: { englishDirectory: directory } }).settings.englishDiary.englishDirectory, directory);
  }
  for (const directory of ["outputs/.private/diaries", "outputs/.english-diary/diaries/../private", "/outputs/.english-diary/diaries"]) {
    assert.equal(normalizeSettingsData({ englishDiary: { englishDirectory: directory } }).settings.englishDiary.englishDirectory, DEFAULT_ENGLISH_DIRECTORY);
  }
  const legacyNormalized = normalizeSettingsData({ englishDiary: {
    legacyEnglishDirectories: [" My Diaries/ ", "My Diaries", "../outside", null],
    legacyExpressionDirectories: [LEGACY_HIDDEN_EXPRESSION_DIRECTORY, "My Expressions", ".other/expressions"]
  } }).settings.englishDiary;
  assert.deepEqual(legacyNormalized.legacyEnglishDirectories, ["My Diaries"]);
  assert.deepEqual(legacyNormalized.legacyExpressionDirectories, [LEGACY_HIDDEN_EXPRESSION_DIRECTORY, "My Expressions"]);
  for (const roots of [[], ["outputs"], ["输出（outputs）"], ["outputs", "输出（outputs）"]]) {
    const storage = normalizeSettingsData({ englishDiary: { englishDirectory: "Old English", expressionDirectory: "Old Expressions" } }).settings;
    const plugin = {
      settings: storage, manifest: { id: "echoink-test" },
      app: { vault: { configDir: ".test-config", getRoot: () => ({ children: roots.map((name) => Object.assign(new TFolder(), { name, path: name })) }) } }
    };
    new EnglishDiaryController(plugin as never);
    const root = roots.includes("outputs") ? "outputs" : "输出（outputs）";
    assert.equal(storage.englishDiary.englishDirectory, `${root}/.english-diary/diaries`);
    assert.equal(storage.englishDiary.expressionDirectory, `${root}/.english-diary/expressions`);
    for (const directory of ["Old English", LEGACY_ENGLISH_DIRECTORY])
      assert.ok(storage.englishDiary.legacyEnglishDirectories?.includes(directory), `migration retains English source ${directory}`);
    for (const directory of ["Old Expressions", LEGACY_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_EXPRESSION_DIRECTORY])
      assert.ok(storage.englishDiary.legacyExpressionDirectories?.includes(directory), `migration retains expression source ${directory}`);
    assert.ok(!storage.englishDiary.legacyEnglishDirectories?.includes(storage.englishDiary.englishDirectory), "the current English target is not a legacy source");
    assert.ok(!storage.englishDiary.legacyExpressionDirectories?.includes(storage.englishDiary.expressionDirectory), "the current expression target is not a legacy source");
    if (root !== "outputs") {
      assert.ok(storage.englishDiary.legacyEnglishDirectories?.includes(DEFAULT_ENGLISH_DIRECTORY), "bilingual destinations retain the old English outputs root");
      assert.ok(storage.englishDiary.legacyExpressionDirectories?.includes(HIDDEN_EXPRESSION_DIRECTORY), "bilingual destinations retain the old expression outputs root");
    }
    const restored = normalizeSettingsData(JSON.parse(JSON.stringify(storage))).settings;
    assert.deepEqual(restored.englishDiary, storage.englishDiary, "resolved hidden paths and migration roots survive saving and reopening");
    new EnglishDiaryController({ ...plugin, settings: restored } as never);
    assert.deepEqual(restored.englishDiary, storage.englishDiary, "reopening does not duplicate old roots");
  }
  const rebuiltSettings = normalizeSettingsData({}).settings;
  new EnglishDiaryController({
    settings: rebuiltSettings, manifest: { id: "echoink-test" },
    app: { vault: { configDir: ".test-config", getRoot: () => ({ children: [Object.assign(new TFolder(), { name: "输出（outputs）", path: "输出（outputs）" })] }) } }
  } as never);
  assert.equal(rebuiltSettings.englishDiary.englishDirectory, "输出（outputs）/.english-diary/diaries");
  assert.equal(rebuiltSettings.englishDiary.expressionDirectory, "输出（outputs）/.english-diary/expressions");
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
