import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { App, Platform } from "obsidian";
import { installProviderModalDomFixture, ProviderModalTestElement } from "echoink:test-settings-dom";
import Plugin from "../main";
import { CodexSettingTab } from "../settings/settings-tab";
import { DEFAULT_SETTINGS } from "../settings/settings";
import { PiLocalDataService } from "../plugin/pi-local-data-service";
import { ProductActivityGate } from "../plugin/api-provider-activation-service";
import { DeveloperModeAccess } from "../plugin/developer-mode/access";
import { DeveloperModeService } from "../plugin/developer-mode/service";
import { MemoryDeveloperBackups } from "../plugin/developer-mode/memory-backups";
import { seedDeveloperMemories } from "../plugin/developer-mode/seed";
import { PersonalMemoryRepository } from "../harness/memory/personal-memory-repository";
import { PersonalMemoryRecallHarness } from "../harness/memory/personal-memory-recall-harness";
import { CognitiveSystem } from "../harness/memory/cognitive-system";
import { DreamScheduler } from "../harness/memory/dream-scheduler";
import { cognitiveAtomicWrite } from "../harness/memory/cognitive-file-utils";
import { createSecondaryRecord, serializeSecondaryRecord } from "../harness/memory/secondary-memory-store";
import { applyDreamProfileUpdate, emptyUserProfileState } from "../harness/memory/user-profile-state";
import { renderUserMarkdown } from "../harness/memory/cognitive-projection";

function unlock(access: DeveloperModeAccess): void {
  for (let i = 0; i < 6; i++) assert.equal(access.click(true), false);
  assert.equal(access.click(true), true);
  access.setEnabled(true);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settingsDomLifecycle(): Promise<void> {
  installProviderModalDomFixture();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  window.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  window.cancelAnimationFrame = (id) => { frames.delete(id); };
  Object.assign(document.defaultView!, {
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame
  });
  const flush = async () => {
    for (let pass = 0; pass < 20; pass++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!frames.size) return;
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(performance.now());
    }
    assert.fail("Settings rendering did not settle");
  };
  let now = 100;
  const access = new DeveloperModeAccess(() => now);
  let statusWait: Promise<void> | null = null;
  let actionWait: Promise<void> | null = null;
  let backup: string | null = null;
  const vaultName = `Disposable DOM fixture ${"long-vault-name-".repeat(8)}`;
  let failStatus = false;
  let reads = 0;
  let saves = 0;
  const actions: string[] = [];
  const system = {
    repository: { readUserControlState: async () => {
      reads++;
      const pending = statusWait;
      statusWait = null;
      await pending;
      if (failStatus) throw new Error("developer_memory_changing");
      return { records: Array.from({ length: 7 }, () => ({ status: "current" })) };
    } },
    dreamStateStore: { read: async () => ({ pendingMemoryIds: ["sample"], lastRunAt: 0, lastSuccessAt: 0 }) },
    scheduler: { lastResult: null }, engine: { isRunning: false },
    forceDreamRun: async () => {
      actions.push("dream");
      return { processedMemoryIds: [], failedMemoryIds: [], factsCreated: 0 };
    }
  };
  const service = new DeveloperModeService(access, {
    getSystem: async () => system as never, vaultName: () => vaultName,
    foregroundBusy: () => false, writable: () => true, withLocalActivity: (action) => action(),
    latestBackup: async () => backup,
    changeMemory: async (action) => {
      actions.push(action);
      await actionWait;
      backup = `fixture/developer-backups/${"long-backup-name-".repeat(12)}.json`;
      return { backup, preservedLearningConflicts: 0 } as never;
    }
  });
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsTab = "general";
  settings.settingsLanguage = "zh-CN";
  const plugin = {
    applyAppearanceTheme: () => undefined,
    getQuickChatWindowController: () => null,
    register: () => undefined, onConversationCatalogChanged: () => () => undefined,
    app: new App(), manifest: { id: "codex-echoink", version: "2.1.0" }, settings,
    developerMode: access, getDeveloperModeService: () => service,
    saveSettings: async () => { saves++; }, refreshLanguageSurfaces: async () => {},
    getCodexView: () => null, isEchoInkOnboardingRequested: () => false
  };
  const previousDesktop = Platform.isDesktopApp;
  Platform.isDesktopApp = true;
  const tab = new CodexSettingTab(plugin as never);
  // Unrelated profile data is unavailable; About and the developer switch must still render.
  (tab as any).personalMemoryError = "fixture";
  const root = tab.containerEl as unknown as ProviderModalTestElement;
  const find = (selector: string, parent = root): ProviderModalTestElement => {
    const element = parent.querySelector(selector);
    assert.ok(element, `Missing settings element: ${selector}`);
    return element;
  };
  const buttons = (parent = root) => parent.querySelectorAll("[data-developer-action]");
  const action = (name: string) => find(`[data-developer-action="${name}"]`);
  const panel = () => find(".echoink-developer-panel");
  const facts = () => Object.fromEntries(find(".echoink-developer-facts").querySelectorAll(".echoink-developer-fact")
    .map((item) => [find("dt", item).textContent, find("dd", item).textContent]));
  const toggle = () => find("input", find("[data-developer-toggle]"));
  const setEnabled = (enabled: boolean) => { toggle().checked = enabled; toggle().fireEvent("change"); };
  const clickLogo = (altKey: boolean) => find(".echoink-about-compact-icon").fireEvent("click", { altKey });
  const confirm = () => {
    const button = panel().querySelectorAll("button").find((item) => /^(确认并执行|Confirm and continue)$/u.test(item.textContent));
    assert.ok(button, "Reset/restore must show a confirmation button");
    return button;
  };
  const navigate = async (name: string) => {
    const button = find(`[data-settings-tab="${name}"]`);
    button.fireEvent("pointerdown");
    button.fireEvent("click");
    await flush();
  };
  const changeLanguage = async (language: string) => {
    const select = find("select");
    select.value = language;
    select.fireEvent("change");
    await flush();
  };
  try {
    tab.display();
    await flush();
    assert.equal(root.querySelector("[data-developer-toggle]"), null);
    access.setEnabled(true);
    assert.equal(access.enabled, false);
    const logo = find(".echoink-about-compact-icon");
    assert.equal(logo.localName, "button", "The entire logo area is a native, keyboard-accessible button");
    assert.equal(logo.getAttribute("type"), "button");
    assert.equal(logo.getAttribute("aria-label"), "EchoInk Agent");
    assert.equal(find(".echoink-about-compact-name").textContent, "EchoInk Agent");
    for (let i = 0; i < 7; i++) find(".echoink-about-compact-version").fireEvent("click", { altKey: true });
    assert.equal(access.revealed, false, "The version number must no longer reveal developer mode");
    for (let i = 0; i < 7; i++) clickLogo(false);
    for (let i = 0; i < 6; i++) clickLogo(true);
    assert.equal(access.revealed, false);
    now += 5_001;
    clickLogo(true);
    assert.equal(root.querySelector("[data-developer-toggle]"), null, "Expired clicks must not reveal the switch");
    clickLogo(false);
    for (let i = 0; i < 6; i++) clickLogo(true);
    now += 5_000;
    clickLogo(true);
    assert.equal(access.revealed, true);
    assert.equal(toggle().checked, false);
    assert.equal(find(".setting-item-name", find(".echoink-developer-settings")).textContent, "显示测试工具");
    assert.equal(find(".echoink-developer-settings").querySelectorAll("h3").filter((item) => item.textContent === "开发者模式").length, 1);
    assert.equal(buttons().length, 0);
    assert.equal(reads, 0);
    assert.deepEqual(actions, []);
    await assert.rejects(service.execute("dream"), /locked/u);
    setEnabled(true);
    assert.equal(find(".echoink-developer-message").getAttribute("role"), "status");
    assert.match(find(".echoink-developer-message").textContent, /正在读取状态/u);
    await flush();
    assert.deepEqual(buttons().map((item) => item.dataset.developerAction), ["seed", "dream", "reset", "restore"]);
    assert.deepEqual(buttons().map((item) => item.textContent), ["生成", "执行", "重置", "恢复"]);
    assert.equal(facts()["记忆"], "7");
    assert.equal(facts()["Dream 待处理"], "1");
    assert.equal(facts()["当前 Vault"], vaultName, "Long Vault names remain complete in the wrapping value field");
    assert.equal(panel().querySelector(".echoink-developer-message"), null, "Empty results must not reserve a message row");
    const refresh = find("button", find(".echoink-developer-status-heading"));
    assert.equal(refresh.textContent, "刷新");
    const previousReads = reads;
    refresh.fireEvent("click");
    await flush();
    assert.equal(reads, previousReads + 1);
    assert.equal(action("restore").disabled, true);
    const staleSeed = action("seed");
    action("reset").fireEvent("click");
    assert.deepEqual(actions, [], "The first reset click only opens confirmation");
    const staleConfirm = confirm();
    assert.ok(find(".echoink-developer-confirm").querySelector("h4"));
    assert.match(find(".echoink-developer-confirm").textContent, /Agent 名称、头像、模板选择及手工修改保留/u);
    setEnabled(false);
    staleSeed.fireEvent("click");
    staleConfirm.fireEvent("click");
    await flush();
    assert.equal(buttons().length, 0);
    assert.equal(access.revealed, true);
    assert.deepEqual(actions, []);
    await assert.rejects(service.execute("reset"), /locked/u);
    assert.equal(saves, 0, "The gesture and developer switch must not persist settings");
    setEnabled(true);
    await flush();
    action("dream").fireEvent("click");
    await flush();
    assert.deepEqual(actions, ["dream"]);
    assert.match(panel().textContent, /Dream 已处理/u);
    assert.equal(find(".echoink-developer-message.is-result").getAttribute("role"), "status");

    failStatus = true;
    tab.display();
    await flush();
    assert.equal(find(".echoink-developer-message.is-error").getAttribute("role"), "status");
    assert.match(find(".echoink-developer-message.is-error").textContent, /记忆正在重置或恢复/u);
    assert.equal(buttons().length, 0);
    failStatus = false;
    tab.display();
    await flush();

    // Invalidate a real pending status read through each settings lifecycle transition.
    for (const transition of ["disable", "navigate", "language", "hide"] as const) {
      const wait = deferred();
      statusWait = wait.promise;
      tab.display();
      await flush();
      const oldPanel = panel();
      assert.equal(buttons(oldPanel).length, 0);
      if (transition === "disable") setEnabled(false);
      if (transition === "navigate") await navigate("models");
      if (transition === "language") await changeLanguage("en");
      if (transition === "hide") tab.hide();
      wait.resolve();
      await flush();
      assert.equal(oldPanel.textContent, "", `${transition}: delayed status must not revive the old panel`);
      if (transition !== "language") assert.equal(buttons().length, 0);
      if (transition === "disable") setEnabled(true);
      if (transition === "navigate") await navigate("general");
      if (transition === "language") {
        assert.equal(find(".echoink-about-compact-name").textContent, "EchoInk Agent");
        assert.equal(facts().Memories, "7");
        assert.equal(facts()["Pending for Dream"], "1");
        assert.deepEqual(buttons().map((item) => item.textContent), ["Generate", "Run", "Reset", "Restore"]);
        assert.equal(action("reset").getAttribute("aria-label"), "Back up and reset memory and Dream");
        assert.doesNotMatch(find(".echoink-developer-settings").textContent, /[\u4e00-\u9fff]/u);
        await changeLanguage("zh-CN");
      }
      if (transition === "hide") tab.display();
      await flush();
      assert.equal(toggle().checked, true);
      assert.equal(buttons().length, 4);
    }

    // Transactions already handed to the host finish normally after leaving the UI.
    for (const operation of ["reset", "restore"] as const) {
      const wait = deferred();
      actionWait = wait.promise;
      const before = actions.length;
      action(operation).fireEvent("click");
      assert.equal(actions.length, before);
      confirm().fireEvent("click");
      await flush();
      assert.equal(actions.at(-1), operation);
      assert.equal(service.busy, true);
      const oldPanel = panel();
      assert.equal(find(".echoink-developer-message.is-busy").getAttribute("role"), "status");
      assert.ok(oldPanel.style.getPropertyValue("min-height"), "Running content retains the previous panel height");
      if (operation === "reset") setEnabled(false);
      else {
        await navigate("models");
        await navigate("general");
        assert.ok(buttons().every((button) => button.disabled), "Reopened panel must reflect the running operation");
      }
      wait.resolve();
      actionWait = null;
      await flush();
      assert.equal(service.busy, false);
      assert.equal(oldPanel.textContent, "");
      if (operation === "reset") {
        assert.equal(buttons().length, 0);
        setEnabled(true);
        await flush();
      }
      assert.ok(buttons().every((button) => !button.disabled), "Current panel must reflect transaction completion");
      assert.equal(panel().style.getPropertyValue("min-height"), "");
      assert.equal(facts()["最近重置备份"], backup, "Long backup paths are retained without truncation");
    }
    assert.deepEqual(actions, ["dream", "reset", "restore"]);
    tab.hide();
    tab.display();
    await flush();
    assert.equal(toggle().checked, true);
    access.reset();
    tab.display();
    await flush();
    assert.equal(root.querySelector("[data-developer-toggle]"), null);
    assert.equal(access.enabled, false);
    const reloaded = new Plugin().developerMode;
    assert.equal(reloaded.revealed, false);
    assert.equal(reloaded.enabled, false);
    await assert.rejects(service.execute("dream"), /locked/u);
    console.log("PASS settings DOM: feather gesture, single title and short actions, complete status values and refresh, loading/error/result/confirmation/busy layouts, async lifecycle, navigation, language, reopen, reload");
  } finally {
    tab.hide();
    Platform.isDesktopApp = previousDesktop;
    root.remove();
    frames.clear();
  }
}

async function repositoryAndLifecycle(): Promise<void> {
  const vault = await fs.mkdtemp(path.join(tmpdir(), "echoink-developer-vault-"));
  const storage = path.join(vault, "plugin-data/pi-agent-product-v1");
  const systems: CognitiveSystem[] = [];
  let foregroundBusy = false;
  let enabled = true;
  let llmMode: "none" | "valid" | "invalid" = "none";
  let calls = 0;
  const makeRepository = async () => {
    const repository = new PersonalMemoryRepository({ vaultPath: storage, vaultId: "developer-fixture", watchExternalChanges: false });
    await repository.initialize();
    return repository;
  };
  const makeSystem = async (repository: PersonalMemoryRepository) => {
    const system = await CognitiveSystem.create({ repository,
      llm: () => llmMode === "none" ? null : { call: async () => { calls++; return llmMode === "valid" ? "no_change" : "{invalid"; } },
      getDreamConfig: () => ({ enabled, runsPerDay: 3 }),
      isForegroundBusy: () => foregroundBusy,
      registerInterval: () => undefined
    });
    systems.push(system);
    return system;
  };
  const reopen = async () => makeSystem(await makeRepository());
  const validateReopen = async () => { const system = await reopen(); await system.dispose(); };
  const recall = (repository: PersonalMemoryRepository) => new PersonalMemoryRecallHarness(repository).prepareTurnContext({
    memoryMode: "normal", query: "Lantern", tokenBudget: 2_000,
    vaultId: "developer-fixture", conversationId: "fixture", piSessionId: "fixture", productRunId: "fixture"
  });
  try {
    let system = await reopen();
    assert.deepEqual(await seedDeveloperMemories(system), { created: 7, existing: 0 });
    const first = await system.repository.readUserControlState();
    assert.equal(new Set(first.records.map((record) => record.kind)).size, 7);
    assert.ok(first.records.every((record) => record.contentOrigin === "hypothesis" && record.source.includes("developer-synthetic")));
    assert.equal((await system.dreamStateStore.read()).pendingMemoryIds.length, 7);
    assert.deepEqual(await seedDeveloperMemories(system), { created: 0, existing: 7 });
    assert.equal((await system.repository.readUserControlState()).revision, first.revision);
    assert.equal(calls, 0);
    assert.ok((await recall(system.repository)).recall!.total > 0);
    enabled = false;
    assert.equal(await system.forceDreamRun(), null);
    enabled = true;
    foregroundBusy = true;
    assert.equal(await system.forceDreamRun(), null);
    foregroundBusy = false;
    assert.equal((await system.forceDreamRun())?.providerUnavailable, true);
    assert.equal(calls, 0);
    llmMode = "invalid";
    const failed = await system.forceDreamRun();
    assert.ok(failed!.failedMemoryIds.length > 0 || failed!.error);
    llmMode = "valid";
    const dream = await system.forceDreamRun();
    assert.equal(dream?.committed, true);
    assert.ok(dream!.processedMemoryIds.length > 0);
    assert.ok(calls > 0);
    assert.deepEqual(system.scheduler.lastResult, dream);
    const access = new DeveloperModeAccess();
    unlock(access);
    const gate = new ProductActivityGate();
    let writable = true;
    const service = new DeveloperModeService(access, {
      getSystem: async () => system, vaultName: () => "Disposable fixture",
      foregroundBusy: () => foregroundBusy || gate.hasActivity, writable: () => writable,
      withLocalActivity: (action) => gate.run(action),
      changeMemory: async () => { throw new Error("unexpected direct change"); }, latestBackup: async () => null
    });
    writable = false;
    await assert.rejects(service.execute("seed"), /read_only/u);
    writable = true;
    foregroundBusy = true;
    await assert.rejects(service.execute("reset"), /busy/u);
    foregroundBusy = false;
    const queued = service.execute("seed");
    await assert.rejects(service.execute("restore"), /busy/u);
    await queued;
    access.setEnabled(false);
    await assert.rejects(service.execute("seed"), /locked/u);

    // Install recognizable sentinels across independent stores and unknown files.
    const sentinels = ["note.md", "plugin-data/data.json", "plugin-data/pi-agent-product-v1/conversations/sentinel.json",
      "plugin-data/knowledge/sentinel.md", "plugin-data/skills/sentinel.md",
      "plugin-data/pi-agent-product-v1/.echoink/shared-user/unknown.txt",
      "plugin-data/pi-agent-product-v1/.echoink/shared-user/.runtime/backups/forgets/unknown-123.md"];
    for (const name of sentinels) {
      const target = path.join(vault, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, `preserve:${name}`);
    }
    const legacyAgent = "# Retired Agent original\nA learned legacy habit remains untouched.\n";
    const legacyMetadata = "not-json: retired growth metadata";
    await fs.mkdir(path.dirname(system.repository.layout.agent), { recursive: true });
    await fs.writeFile(system.repository.layout.agent, legacyAgent);
    await fs.writeFile(system.repository.layout.agentSelfMetadata, legacyMetadata);
    await fs.writeFile(system.repository.layout.agentIdentity, "legacy identity original");
    const parent = first.records[0];
    const profile = applyDreamProfileUpdate(emptyUserProfileState(Date.now()), {
      items: [{ section: "preference", profileKey: "preference.workflow", text: "A fixture-derived preference", basis: "explicit_memory", sourceMemoryId: parent.id }],
      processedSources: [{ memoryId: parent.id, memoryRevision: parent.revision }], now: Date.now()
    });
    const userContent = renderUserMarkdown(profile);
    const secondary = createSecondaryRecord({ parentId: parent.id, sourceMemoryRevision: parent.revision,
      title: "Fixture clue", content: "A synthetic association", recallWhen: "Lantern fixture",
      matchTerms: ["Lantern"], relation: "associated", reason: "Synthetic fixture", basis: "llm_inferred",
      confidence: 0.8, supportLevel: "direct", evidence: parent.content.slice(0, 80), now: Date.now()
    });
    await system.repository.applyCognitiveUpdate({
      userContent,
      secondaryRecords: [secondary], detail: "developer-fixture-derived-state",
      extraChanges: [
        { relativePath: "shared-user/user-profile-state.json", content: JSON.stringify({ ...profile, lastProjectedUserHash: createHash("sha256").update(userContent).digest("hex") }) },
        { relativePath: secondary.file, content: serializeSecondaryRecord(secondary) }
      ]
    });
    const forgotten = await system.repository.write({ operation: "create", kind: "fact", title: "Forget fixture", content: "Synthetic forgotten record", basis: "explicit" }, {
      vaultId: "developer-fixture", conversationId: "fixture", piSessionId: "fixture", productRunId: "fixture", userEntryId: "forgotten", memoryMode: "normal"
    });
    await system.repository.forgetFromUserControl(forgotten.record!.id, "fixture", forgotten.revision);
    const currentRevision = (await system.repository.readUserControlState()).revision;
    await system.repository.forgetFromUserControl(first.records[1].id, "forget then restore fixture", currentRevision);
    await system.repository.restoreForgotten(first.records[1].id, (await system.repository.readUserControlState()).revision);
    const identityBytes = await fs.readFile(system.repository.layout.agentIdentity);
    const beforeAgent = await fs.readFile(system.repository.layout.agent);
    const root = system.repository.layout.root;
    const backups = new MemoryDeveloperBackups(root);
    await system.dispose();
    const { backup } = await backups.change("reset", validateReopen);
    assert.equal(await backups.latestResetPath(), backup);
    await assert.rejects(system.repository.readUserControlState(), /disposed/u);
    system = await reopen();
    assert.equal((await system.repository.readUserControlState()).records.length, 0);
    assert.equal((await system.dreamStateStore.read()).pendingMemoryIds.length, 0);
    assert.equal((await system.repository.readUserControlState()).forgottenIds.length, 0);
    assert.equal((await system.listAllSecondary()).length, 0);
    assert.doesNotMatch((await system.repository.readUserControlState()).user, /fixture-derived/u);
    assert.equal((await recall(system.repository)).recall!.total, 0);
    assert.ok(identityBytes.equals(await fs.readFile(system.repository.layout.agentIdentity)));
    assert.equal(await fs.readFile(system.repository.layout.agent, "utf8"), legacyAgent);
    assert.equal(await fs.readFile(system.repository.layout.agentSelfMetadata, "utf8"), legacyMetadata);
    await system.dispose();
    const beforeBackup = await fs.readFile(backup);
    const { backup: protectedCurrent } = await backups.change("restore", validateReopen);
    assert.notEqual(protectedCurrent, backup);
    assert.ok(beforeBackup.equals(await fs.readFile(backup)));
    system = await reopen();
    assert.equal((await system.repository.readUserControlState()).records.length, 7);
    assert.equal((await system.repository.readUserControlState()).forgottenIds.length, 1);
    assert.equal((await system.listAllSecondary()).length, 1);
    assert.match((await system.repository.readUserControlState()).user, /fixture-derived/u);
    assert.ok((await recall(system.repository)).recall!.total > 0);
    assert.ok(beforeAgent.equals(await fs.readFile(system.repository.layout.agent)));
    for (const name of sentinels) assert.equal(await fs.readFile(path.join(vault, name), "utf8"), `preserve:${name}`);
    await system.dispose();

    const originalManifest = await fs.readFile(path.join(root, "shared-user/.runtime/manifest.json"));
    const brokenBackup = new MemoryDeveloperBackups(root, { atomicWrite: async () => { throw new Error("fixture_backup_failure"); } });
    await assert.rejects(brokenBackup.change("reset", validateReopen), /fixture_backup_failure/u);
    assert.ok(originalManifest.equals(await fs.readFile(path.join(root, "shared-user/.runtime/manifest.json"))));
    let failOnce = true;
    const partialFailure = new MemoryDeveloperBackups(root, { atomicWrite: async (target, bytes) => {
      if (target.endsWith("active-change.json") && bytes.toString().includes('"committed":true') && failOnce) { failOnce = false; throw new Error("fixture_partial_write_failure"); }
      await cognitiveAtomicWrite(target, bytes);
    } });
    await assert.rejects(partialFailure.change("reset", validateReopen), /rolled_back/u);
    assert.ok(originalManifest.equals(await fs.readFile(path.join(root, "shared-user/.runtime/manifest.json"))));
    await assert.rejects(backups.change("reset", async () => { throw new Error("fixture_reopen_failure"); }), /rolled_back/u);
    assert.ok(originalManifest.equals(await fs.readFile(path.join(root, "shared-user/.runtime/manifest.json"))));
    // Simulate an interrupted transaction. Startup recovery uses the immutable snapshot.
    const snapshot = JSON.parse(beforeBackup.toString("utf8"));
    const journal = path.join(backups.directory, "active-change.json");
    await fs.writeFile(journal, JSON.stringify({ schema: "echoink.developer-memory-change.v1", before: path.basename(backup), paths: Object.keys(snapshot.files), committed: false }));
    const memoryPath = path.join(root, first.records[0].file);
    await fs.unlink(memoryPath);
    await backups.recoverInterruptedChange();
    assert.equal((await fs.stat(memoryPath)).isFile(), true);

    // Exercise the production plugin orchestration with disposable local stores.
    llmMode = "none";
    system = await reopen();
    await pluginResetLifecycle(system, reopen, vault);
    console.log("PASS real Repository seven kinds, dedupe, queue, Scheduler/Engine, backup/reset/restore, Recall, sentinels, rollback, startup recovery, plugin lifecycle");
  } finally {
    for (const system of systems) await system.dispose();
    await fs.rm(vault, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function pluginResetLifecycle(system: CognitiveSystem, reopen: () => Promise<CognitiveSystem>, vault: string): Promise<void> {
  const originalCreate = PiLocalDataService.create;
  const host = Object.create(Plugin.prototype) as any;
  const access = new DeveloperModeAccess();
  unlock(access);
  let shutdowns = 0;
  const local = (cognitive: CognitiveSystem) => ({ personalMemory: cognitive.repository, dispose: () => cognitive.repository.dispose() });
  Object.assign(host, {
    developerMode: access, developerMemoryChanging: false,
    settings: { defaultPermission: "workspace-write", memory: { useLongTermMemory: true, dreamEnabled: true, dreamRunsPerDay: 3 } },
    productActivity: new ProductActivityGate(), piRunConversations: new Map(), piSubmittingConversations: new Set(),
    piConversationActivationTasks: new Map(), piConversationActivationLane: Promise.resolve(),
    piLocalData: local(system), piLocalDataFlight: null, cognitiveSystem: system, cognitiveSystemFlight: null,
    piRuntimeBundle: { runtime: { shutdown: async () => { shutdowns++; } } }, piRuntimeFlight: null,
    personalMemoryCorrection: { stale: true },
    createDreamLlmPort: () => null, registerInterval: () => undefined, getCodexView: () => null,
    getVaultPath: () => vault
  });
  (PiLocalDataService as any).create = async () => {
    assert.equal(host.developerMemoryChanging, true);
    await assert.rejects(host.ensurePiLocalData(), /changing/u);
    await assert.rejects(host.ensurePiProductionRuntime(), /changing/u);
    await assert.rejects(host.productActivity.run(async () => undefined), /切换/u);
    const next = await reopen();
    await next.dispose();
    const repository = new PersonalMemoryRepository({ vaultPath: path.dirname(next.repository.layout.root), vaultId: "developer-fixture", watchExternalChanges: false });
    await repository.initialize();
    return { personalMemory: repository, dispose: () => repository.dispose() };
  };
  try {
    host.piRunConversations.set("run", "chat");
    await assert.rejects(host.changeDeveloperMemory("reset"), /busy/u);
    host.piRunConversations.clear();
    await host.changeDeveloperMemory("reset");
    assert.equal(shutdowns, 1);
    assert.equal(host.piRuntimeBundle, null);
    assert.equal(host.personalMemoryCorrection, null);
    assert.notEqual(host.piLocalData.personalMemory, system.repository);
    assert.equal((await host.getEchoInkPersonalMemoryState()).records.length, 0);
    const agentPath = host.cognitiveSystem.repository.layout.agent;
    await fs.writeFile(agentPath, "# A manually kept legacy identity note.\n");
    const changed = await host.changeDeveloperMemory("restore");
    assert.equal(changed.preservedLearningConflicts, 0);
    assert.equal(await fs.readFile(agentPath, "utf8"), "# A manually kept legacy identity note.\n");
    assert.equal((await host.getEchoInkPersonalMemoryState()).records.length, 7);
    assert.equal(host.developerMemoryChanging, false);
    assert.equal(host.piRuntimeBundle, null, "local operations never require Provider Runtime");
  } finally {
    PiLocalDataService.create = originalCreate;
    await host.cognitiveSystem?.dispose();
  }
}

async function schedulerDisposeDuringDueRead(): Promise<void> {
  let release!: (value: number) => void;
  let calls = 0;
  const scheduler = new DreamScheduler({
    engine: { isRunning: false, runOnce: async () => { calls++; } } as never,
    getConfig: () => ({ enabled: true, runsPerDay: 3 }), isForegroundBusy: () => false,
    readLastRunAt: () => new Promise((resolve) => { release = resolve; }), registerInterval: () => undefined
  });
  const pending = scheduler.tick();
  scheduler.dispose();
  release(0);
  await pending;
  assert.equal(calls, 0);
  assert.equal(await scheduler.forceRun(), null);
  console.log("PASS scheduler disposed during asynchronous due check");
}

if (process.env.ECHOINK_DEVELOPER_MODE_CASE !== "dream") await settingsDomLifecycle();
await repositoryAndLifecycle();
await schedulerDisposeDuringDueRead();
