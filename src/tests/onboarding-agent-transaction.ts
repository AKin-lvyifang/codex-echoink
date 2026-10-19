import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import CodexForObsidianPlugin from "../main";
import { CodexView } from "../ui/codex-view";
import { AGENT_PRESETS } from "../agents/presets";
import { AGENT_MODULE_IDS, type AgentDefinition } from "../agents/types";
import { DEFAULT_SETTINGS, normalizeSettingsData, type CodexForObsidianSettings } from "../settings/settings";
import { ECHOINK_ONBOARDING_VERSION, prepareEchoInkOnboardingTutorial, shouldAutoStartEchoInkOnboarding } from "../settings/onboarding";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const organizer = AGENT_PRESETS.find(item => item.presetId === "organizer")!;
const colleague = (id: string): AgentDefinition => ({ ...structuredClone(organizer.agent), id });

export async function runOnboardingAgentTransactionTests(root: string): Promise<void> {
  let fixtureSequence = 0;
  const allSideEffects: string[] = [];
  const fixture = async (raw?: unknown) => {
    const settings = normalizeSettingsData(raw ?? structuredClone(DEFAULT_SETTINGS)).settings;
    if (raw === undefined) {
      settings.setup = { ...settings.setup, tutorialStep: "colleague", tutorialVersion: ECHOINK_ONBOARDING_VERSION, completedAt: 0, dismissedVersion: "", onboardingAgentId: "", paperGuideDismissedAt: 37 };
      settings.agentRegistry.agents.push(colleague("manual-same-name"));
      settings.agentRegistry.moduleOwners["knowledge-base"] = "manual-same-name";
      settings.apiProviders = []; settings.activeApiProviderId = "";
    }
    const file = path.join(root, `transaction-settings-${++fixtureSequence}.json`);
    await writeFile(file, JSON.stringify(settings));
    const before = structuredClone(settings);
    const attempts: Array<{ settings: CodexForObsidianSettings; requested: boolean }> = [];
    const commits: CodexForObsidianSettings[] = [], notifications: CodexForObsidianSettings[] = [];
    let saveGate: ReturnType<typeof deferred> | null = null, entered: ReturnType<typeof deferred> | null = null, fail = false;
    const unexpected = (name: string) => () => { allSideEffects.push(name); throw new Error(`Unexpected task/provider call: ${name}`); };
    const noRuntime = new Proxy({}, { get(_target, key) { return unexpected(`runtime.${String(key)}`); } });
    const runService = new Proxy({ isAgentBlocked: () => false, runs: new Map() }, {
      get(target, key) { return key in target ? Reflect.get(target, key) : unexpected(`runs.${String(key)}`); }
    });
    // Keep the production prototype and queue methods; only replace the host's
    // persistence and unrelated task/provider boundaries with synthetic ports.
    const plugin = Object.assign(Object.create(CodexForObsidianPlugin.prototype), {
      settings, onboardingRequested: shouldAutoStartEchoInkOnboarding(false, settings.setup),
      agentRegistryWriteTail: Promise.resolve(), agentRegistryListeners: new Set<() => void>(),
      conversationRunService: runService, piRuntimeBundle: { runtime: noRuntime },
      getCodexView: () => null,
      getConversationRunService: unexpected("getConversationRunService"),
      ensurePiProductionRuntime: unexpected("ensurePiProductionRuntime"),
      ensurePiLocalData: unexpected("ensurePiLocalData"),
      submitPiChat: unexpected("submitPiChat"), createPiConversation: unexpected("createPiConversation"),
      createPiProductionModelDefinition: unexpected("createPiProductionModelDefinition"),
      buildRuntimeEchoInkResourceCatalog: unexpected("buildRuntimeEchoInkResourceCatalog"),
      activateHomeAndSidebar: unexpected("activateHomeAndSidebar"),
      clearEchoInkOnboardingWorkspaceCoachmark: unexpected("clearEchoInkOnboardingWorkspaceCoachmark"),
      getViewService: unexpected("getViewService"),
      async saveSettings(immediate: boolean) {
        assert.equal(immediate, true, "the transaction must request a durable settings save");
        const snapshot = structuredClone(plugin.settings);
        attempts.push({ settings: snapshot, requested: plugin.isEchoInkOnboardingRequested() });
        entered?.resolve();
        if (saveGate) await saveGate.promise;
        if (fail) throw new Error("synthetic-settings-write-rejected");
        await writeFile(file, JSON.stringify(snapshot));
        commits.push(snapshot);
      }
    });
    plugin.onAgentRegistryChanged(() => { notifications.push(structuredClone(plugin.settings)); });
    return { plugin, before, attempts, commits, notifications, runService,
      failSave(value: boolean) { fail = value; },
      pauseSave() { saveGate = deferred(); entered = deferred(); return { entered: entered.promise, release: () => { saveGate?.resolve(); } }; },
      async disk() { return JSON.parse(await readFile(file, "utf8")) as CodexForObsidianSettings; },
      assertNoExecution() {
        assert.deepEqual(allSideEffects, []); assert.equal(runService.runs.size, 0);
        assert.deepEqual(plugin.settings.sessions, before.sessions, "creating an Agent must not create a conversation");
        assert.deepEqual(plugin.settings.taskWorkspace, before.taskWorkspace, "creating an Agent must not alter task drafts or runs");
        assert.deepEqual(plugin.settings.apiProviders, before.apiProviders, "no provider setup is required or changed");
      }
    };
  };

  {
    const f = await fixture(), agent = colleague("transaction-success");
    assert.equal(f.plugin.saveOnboardingAgentDefinition, CodexForObsidianPlugin.prototype.saveOnboardingAgentDefinition);
    assert.equal(f.plugin.saveAgentDefinition, CodexForObsidianPlugin.prototype.saveAgentDefinition);
    const gate = f.pauseSave();
    const saving = f.plugin.saveOnboardingAgentDefinition(agent, organizer.moduleIds);
    await gate.entered;
    assert.equal(f.attempts.length, 1); assert.equal(f.commits.length, 0); assert.equal(f.notifications.length, 0);
    const captured = f.attempts[0];
    assert.deepEqual(captured.settings.agentRegistry.agents.find(item => item.id === agent.id), { ...agent, identityEdited: true });
    assert.equal(captured.settings.agentRegistry.moduleOwners["knowledge-base"], agent.id);
    assert.equal(captured.settings.setup.onboardingAgentId, agent.id);
    assert.ok(captured.settings.setup.completedAt > 0); assert.equal(captured.settings.setup.lastCheckedAt, captured.settings.setup.completedAt);
    assert.equal(captured.settings.setup.tutorialStep, "sidebar"); assert.equal(captured.settings.setup.paperGuideDismissedAt, 0);
    assert.equal(captured.settings.setup.dismissedVersion, ECHOINK_ONBOARDING_VERSION); assert.equal(captured.requested, false);
    assert.deepEqual(await f.disk(), f.before, "disk remains at its old snapshot while the one write is pending");
    gate.release(); await saving;
    assert.equal(f.commits.length, 1); assert.equal(f.notifications.length, 1);
    assert.deepEqual(await f.disk(), captured.settings); assert.equal(f.plugin.isEchoInkOnboardingRequested(), false);
    assert.deepEqual(f.plugin.settings.agentRegistry.agents.find((item: AgentDefinition) => item.id === "manual-same-name"), f.before.agentRegistry.agents.find(item => item.id === "manual-same-name"), "same display names are not merged");
    for (const id of AGENT_MODULE_IDS.filter(id => id !== "knowledge-base")) assert.equal(captured.settings.agentRegistry.moduleOwners[id], f.before.agentRegistry.moduleOwners[id]);
    f.assertNoExecution();
    console.log("PASS production prototype performs one settings write containing Agent, selected owner and completion record; unrelated state and same-name Agent survive");

    const persisted = await f.disk();
    for (const snapshot of [persisted, { ...persisted, setup: { ...persisted.setup, tutorialVersion: "onboarding-v1", dismissedVersion: "" } }]) {
      const reloaded = normalizeSettingsData(JSON.parse(JSON.stringify(snapshot))).settings;
      const original = structuredClone(reloaded.setup);
      for (const emptyData of [false, true]) for (const enabledAfterLayoutReady of [false, true])
        assert.equal(shouldAutoStartEchoInkOnboarding(emptyData, reloaded.setup, enabledAfterLayoutReady), false);
      assert.equal(prepareEchoInkOnboardingTutorial(reloaded.setup, { forceRestart: false }), false);
      assert.deepEqual(reloaded.setup, original);
      const restarted = await fixture(reloaded);
      await restarted.plugin.openPendingEchoInkOnboarding();
      await restarted.plugin.saveOnboardingAgentDefinition(agent, organizer.moduleIds);
      assert.equal(restarted.attempts.length, 0, "reload recognizes the persisted creation ID without another write");
      assert.equal(restarted.plugin.shouldAutoOpenEchoInkOnboarding(), false); restarted.assertNoExecution();
    }
    console.log("PASS persisted settings reload keeps the creation ID and historical completion suppresses onboarding, including older tutorial versions");
  }
  {
    const f = await fixture(), agent = colleague("transaction-rollback");
    const originalRegistry = f.plugin.settings.agentRegistry;
    f.failSave(true);
    await assert.rejects(f.plugin.saveOnboardingAgentDefinition(agent, organizer.moduleIds), /synthetic-settings-write-rejected/);
    assert.equal(f.attempts.length, 1); assert.equal(f.commits.length, 0); assert.equal(f.notifications.length, 0);
    assert.equal(f.plugin.settings.agentRegistry, originalRegistry);
    assert.deepEqual(f.plugin.settings, f.before); assert.deepEqual(await f.disk(), f.before);
    assert.equal(f.plugin.isEchoInkOnboardingRequested(), true);
    f.failSave(false); await f.plugin.saveOnboardingAgentDefinition(agent, organizer.moduleIds);
    assert.equal(f.attempts.length, 2); assert.equal(f.commits.length, 1);
    assert.equal((await f.disk()).setup.onboardingAgentId, agent.id);
    assert.equal(f.plugin.settings.agentRegistry.agents.filter((item: AgentDefinition) => item.id === agent.id).length, 1);
    f.assertNoExecution();
    console.log("PASS rejected settings write rolls back registry, all setup fields and requested state; the same ID can retry through the real queue");
  }
  {
    const f = await fixture(), agent = colleague("transaction-concurrent-same");
    const gate = f.pauseSave();
    const pending = Promise.all([
      f.plugin.saveOnboardingAgentDefinition(agent, organizer.moduleIds),
      f.plugin.saveOnboardingAgentDefinition(agent, organizer.moduleIds)
    ]);
    await gate.entered; assert.equal(f.attempts.length, 1); gate.release(); await pending;
    assert.equal(f.attempts.length, 1); assert.equal(f.commits.length, 1);
    assert.equal(f.plugin.settings.agentRegistry.agents.filter((item: AgentDefinition) => item.id === agent.id).length, 1);
    const persisted = await f.disk();
    await f.plugin.saveOnboardingAgentDefinition({ ...agent, name: "重入不覆盖原定义" }, ["finance"]);
    assert.equal(f.attempts.length, 1); assert.deepEqual(await f.disk(), persisted);
    assert.deepEqual(f.plugin.settings, persisted); f.assertNoExecution();
    console.log("PASS parallel same-ID submissions and later reentry result in one durable write and cannot overwrite the saved definition or module owners");
  }
  {
    const f = await fixture(), first = colleague("transaction-first"), second = colleague("transaction-other");
    const gate = f.pauseSave();
    const pending = Promise.allSettled([
      f.plugin.saveOnboardingAgentDefinition(first, organizer.moduleIds),
      f.plugin.saveOnboardingAgentDefinition(second, ["finance"])
    ]);
    await gate.entered; assert.equal(f.attempts.length, 1); gate.release();
    const [accepted, rejected] = await pending;
    assert.equal(accepted.status, "fulfilled"); assert.equal(rejected.status, "rejected");
    if (rejected.status === "rejected") assert.match(String(rejected.reason), /已经创建|already created/);
    assert.equal(f.attempts.length, 1); assert.equal(f.commits.length, 1);
    assert.equal(f.plugin.settings.agentRegistry.agents.some((item: AgentDefinition) => item.id === second.id), false);
    assert.equal(f.plugin.settings.agentRegistry.moduleOwners.finance, f.before.agentRegistry.moduleOwners.finance);
    assert.equal((await f.disk()).setup.onboardingAgentId, first.id); f.assertNoExecution();
    console.log("PASS parallel different-ID submission is rejected after the first transaction and cannot create another Agent or move another module");
  }
  {
    for (const createdId of ["", "missing-created-agent"]) {
      const f = await fixture(); f.plugin.settings.setup.onboardingAgentId = createdId;
      const before = structuredClone(f.plugin.settings);
      await assert.rejects(f.plugin.advanceEchoInkOnboarding("colleague"), /请先创建|Create your colleague first/);
      assert.deepEqual(f.plugin.settings, before); assert.equal(f.plugin.isEchoInkOnboardingRequested(), true);
      assert.equal(f.attempts.length, 0); f.assertNoExecution();
    }
    const ordinary = await fixture(), agent = colleague("ordinary-creation");
    await ordinary.plugin.saveAgentDefinition(agent, organizer.moduleIds);
    assert.equal(ordinary.attempts.length, 1); assert.deepEqual(ordinary.plugin.settings.setup, ordinary.before.setup);
    assert.equal(ordinary.plugin.isEchoInkOnboardingRequested(), true); ordinary.assertNoExecution();
    console.log("PASS ordinary advance cannot complete without a real recorded colleague; ordinary Agent saves do not complete onboarding; all cases start zero runs/providers");
  }
  assert.deepEqual(allSideEffects, []);
  onboardingEditorEntryReentry();
}

function onboardingEditorEntryReentry(): void {
  for (const pending of [false, true]) {
    const calls: string[] = [];
    let leaveCompletion: (() => void) | undefined;
    const guidedHost = { onboarding: true, saveAgent: () => { calls.push("guided-save"); } };
    const input = { focus() { calls.push("focus-current-input"); } };
    const header = { guidedHeader: true };
    const editor = {
      host: guidedHost,
      element: { querySelector(selector: string) { assert.equal(selector, "input"); return input; } },
      isPending: () => pending,
      dispose() { calls.push("dispose-guided-editor"); },
      requestLeave(done: () => void) { calls.push("request-leave"); leaveCompletion = done; }
    };
    const unexpected = (name: string) => () => { assert.fail(`Guided editor reentry must not ${name}`); };
    // Exercise both production View entry methods and its real leave wrapper.
    // The existing controller is a lifecycle spy: a guarded leave stays pending
    // until the user confirms, so no replacement/render path should run here.
    const view = Object.assign(Object.create(CodexView.prototype), {
      plugin: { hideEchoInkOnboardingWorkspaceCard: unexpected("hide the guide before confirmation") },
      taskEditor: editor, taskEditorOnboarding: true,
      taskEditorEl: { querySelector(selector: string) { assert.equal(selector, ".echoink-agent-editor-header"); return header; } },
      saveTaskComposerDraft: unexpected("save a different composer draft"),
      rememberTaskListPosition: unexpected("replace the editor destination"),
      closeComposerMenus: unexpected("start another editor mount"),
      renderTaskPages: unexpected("render a replacement editor")
    });
    assert.equal(view.openAgentEditor, (CodexView.prototype as any).openAgentEditor);
    assert.equal(view.requestOnboardingEditorLeave, CodexView.prototype.requestOnboardingEditorLeave);
    assert.equal(editor.isPending(), pending);

    view.openAgentEditor(); // The roster's ordinary + invokes this exact entry.
    assert.deepEqual(calls, ["focus-current-input"]);
    assert.equal(view.taskEditor, editor); assert.equal(view.taskEditor.host, guidedHost);
    assert.equal(view.taskEditorOnboarding, true); assert.equal(leaveCompletion, undefined);

    assert.equal(view.openOnboardingAgentEditor(), header, "reentering the guide keeps its current anchor");
    assert.deepEqual(calls, ["focus-current-input", "focus-current-input"]);
    assert.equal(view.taskEditor, editor); assert.equal(view.taskEditor.host.saveAgent, guidedHost.saveAgent);
    assert.equal(view.taskEditorOnboarding, true);

    view.openAgentEditor("sol");
    assert.deepEqual(calls, ["focus-current-input", "focus-current-input", "request-leave"]);
    assert.equal(typeof leaveCompletion, "function", "opening an existing Agent must wait for the current editor's leave guard");
    assert.equal(view.taskEditor, editor); assert.equal(view.taskEditor.host, guidedHost);
    assert.equal(view.taskEditorOnboarding, true, "a pending/cancelled guard cannot switch the guided host");
  }
  console.log("PASS production CodexView roster + and guided reentry preserve the current editor/host during editing and pending save; an Agent ID first requests guarded leave");
}
