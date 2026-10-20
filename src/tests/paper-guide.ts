import assert from "node:assert/strict";
import type CodexForObsidianPlugin from "../main";
import type { CapabilityAccess } from "../membership/types";
import { PaperGuideController } from "../plugin/paper-guide-controller";
import {
  advanceEchoInkOnboardingTutorial,
  dismissEchoInkOnboardingTutorial,
  ECHOINK_ONBOARDING_STEPS,
  prepareEchoInkOnboardingTutorial
} from "../settings/onboarding";
import { normalizeSettingsData } from "../settings/settings";
import { PaperGuideModal } from "./paper-guide-modal-shim";
import { TaskNavigationState } from "../ui/codex-view/task-navigation-state";
import type { AgentModuleId } from "../agents/types";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Frames {
  private sequence = 0;
  private readonly callbacks = new Map<number, FrameRequestCallback>();
  requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const id = ++this.sequence;
    this.callbacks.set(id, callback);
    return id;
  };
  cancelAnimationFrame = (id: number): void => { this.callbacks.delete(id); };
  get pending(): number { return this.callbacks.size; }
  paint(): void {
    const current = [...this.callbacks.entries()];
    for (const [id, callback] of current) {
      this.callbacks.delete(id);
      callback(0);
    }
  }
}

function fixture(input: { paid?: boolean; enabled?: boolean; saved?: unknown; language?: "zh-CN" | "en" } = {}) {
  const frames = new Frames();
  const document = {
    defaultView: frames,
    hidden: false,
    blockedByModal: false,
    querySelector: (_selector: string) => document.blockedByModal ? {} : null
  };
  const home = {
    ownerDocument: document,
    isConnected: true,
    visible: true,
    getClientRects: () => home.visible ? [{ width: 100, height: 100 }] : []
  };
  let activeHome: unknown = home;
  let paid = input.paid ?? true;
  let requested = false;
  const listeners = new Set<() => void>();
  const registryListeners = new Set<() => void>();
  const access: CapabilityAccess = {
    checkCapability: () => paid,
    requireCapability: () => { if (!paid) throw new Error("PRO_REQUIRED"); },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }
  };
  const settings = normalizeSettingsData(input.saved ?? {
    settingsLanguage: input.language ?? "zh-CN",
    setup: { completedAt: 1 },
    englishDiary: { enabled: input.enabled ?? true },
    lifestyle: { finance: { enabled: input.enabled ?? true } }
  }).settings;
  for (const [module, id, name] of [["english-diary", "english-owner", "英语同事"], ["finance", "finance-owner", "财务同事"], ["knowledge-base", "knowledge-owner", "知识同事"]] as const) {
    if (!settings.agentRegistry.agents.some(agent => agent.id === id)) settings.agentRegistry.agents.push({ ...structuredClone(settings.agentRegistry.agents[0]), id, name });
    settings.agentRegistry.moduleOwners[module] = id;
  }
  const events: string[] = [];
  const listCalls: unknown[][] = [];
  const executionCalls: string[] = [];
  const forbidden = (name: string) => async () => { executionCalls.push(name); throw new Error(`Prefill invoked ${name}`); };
  const state = {
    saved: undefined as unknown,
    saves: 0,
    saveError: false,
    saveGate: null as ReturnType<typeof deferred> | null,
    listError: false,
    saveArguments: [] as unknown[][]
  };
  const plugin = {
    app: { vault: { create: forbidden("vault:create"), modify: forbidden("vault:modify") } }, settings, accountService: access as CapabilityAccess | null,
    onAgentRegistryChanged: (listener: () => void) => { registryListeners.add(listener); return () => { registryListeners.delete(listener); }; },
    isEchoInkOnboardingRequested: () => requested,
    async saveSettings(...args: unknown[]) {
      events.push("save:start"); state.saves++; state.saveArguments.push(args);
      if (state.saveGate) await state.saveGate.promise;
      if (state.saveError) throw new Error("SAVE_FAILED");
      state.saved = structuredClone(plugin.settings);
      events.push("save:done");
    },
    async openAgentTaskList(...args: [agentId: string, text?: string]) {
      listCalls.push(args); events.push(`tasks:${args[0]}`);
      if (state.listError) throw new Error("TASK_LIST_FAILED");
      navigation.navigate({ kind: "list", agentId: args[0] });
      return args[1] === undefined || navigation.prefill(args[0], args[1]);
    },
    englishDiary: { setEnabled: forbidden("english:enable"), openToday: forbidden("english:openToday"), generate: forbidden("english:generate") },
    lifestyle: { setEnabled: forbidden("finance:enable"), open: forbidden("finance:open"), record: forbidden("finance:record") },
    openEchoInkKnowledgeSettings: forbidden("knowledge:settings"), openEchoInkAccountSettings: forbidden("account:settings"),
    activateKnowledgeView: forbidden("knowledge:open"), createPiConversation: forbidden("task:create"),
    submitPiTurn: forbidden("turn:send"), ensurePiRuntimeBundle: forbidden("Provider"), resumeTaskAndOpenDetail: forbidden("run:start")
  };
  const navigation = new TaskNavigationState(() => plugin.settings.taskWorkspace);
  const controllers: PaperGuideController[] = [];
  const newController = () => {
    const controller = new PaperGuideController(plugin as unknown as CodexForObsidianPlugin, () => activeHome as HTMLElement | null);
    controllers.push(controller);
    return controller;
  };
  const controller = newController();
  const initialInstances = PaperGuideModal.instances.length;
  return {
    frames, document, home, plugin, state, events, listeners, registryListeners, controller, newController, navigation, listCalls, executionCalls,
    setOwner(module: AgentModuleId, id: string) { plugin.settings.agentRegistry.moduleOwners[module] = id; for (const listener of registryListeners) listener(); },
    setPaid(value: boolean) { paid = value; for (const listener of listeners) listener(); },
    requestOnboarding(value: boolean) { requested = value; },
    leaveHome() { activeHome = null; },
    instances: () => PaperGuideModal.instances.slice(initialInstances),
    async open() {
      const showing = controller.showAfterOnboarding();
      frames.paint(); frames.paint(); await showing;
      const modal = this.instances().at(-1);
      assert.ok(modal?.opened, "guide opens after the returned Home paints");
      return modal;
    },
    dispose() { for (const controller of controllers) controller.dispose(); }
  };
}

async function timingAndCancellation(): Promise<void> {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.plugin.settings.setup.completedAt = 0; },
    (f: ReturnType<typeof fixture>) => f.requestOnboarding(true),
    (f: ReturnType<typeof fixture>) => { f.plugin.settings.setup.paperGuideDismissedAt = 10; },
    (f: ReturnType<typeof fixture>) => f.leaveHome()
  ]) {
    const f = fixture(); mutate(f);
    await f.controller.showAfterOnboarding();
    assert.equal(f.instances().length, 0); assert.equal(f.frames.pending, 0);
    f.dispose();
  }
  const f = fixture();
  const showing = f.controller.showAfterOnboarding();
  const concurrent = f.controller.showAfterOnboarding();
  assert.equal(f.instances().length, 0);
  assert.equal(f.frames.pending, 1, "concurrent calls schedule only one paint sequence");
  f.frames.paint(); await Promise.resolve();
  assert.equal(f.instances().length, 0, "one RAF is insufficient to display the guide");
  f.frames.paint(); await Promise.all([showing, concurrent]);
  assert.equal(f.instances().length, 1);
  await f.controller.showAfterOnboarding(); assert.equal(f.instances().length, 1);
  assert.equal(f.listeners.size, 1);
  assert.equal(f.registryListeners.size, 1);
  f.dispose();
  assert.equal(f.listeners.size, 0); assert.equal(f.registryListeners.size, 0); assert.equal(f.instances()[0].disposed, true);
  assert.equal(f.state.saves, 0, "unloading an open guide does not mark it completed");

  for (const cancel of [
    (f: ReturnType<typeof fixture>) => f.leaveHome(),
    (f: ReturnType<typeof fixture>) => { f.home.isConnected = false; },
    (f: ReturnType<typeof fixture>) => { f.home.visible = false; },
    (f: ReturnType<typeof fixture>) => { f.document.hidden = true; },
    (f: ReturnType<typeof fixture>) => { f.document.blockedByModal = true; },
    (f: ReturnType<typeof fixture>) => f.requestOnboarding(true)
  ]) {
    const f = fixture();
    const showing = f.controller.showAfterOnboarding();
    f.frames.paint(); cancel(f); f.frames.paint(); await showing;
    assert.equal(f.instances().length, 0, "Home must still be eligible after painting");
    assert.equal(f.state.saves, 0); f.dispose();
  }
  for (const paintsBeforeDispose of [0, 1]) {
    const f = fixture(); const showing = f.controller.showAfterOnboarding();
    if (paintsBeforeDispose) f.frames.paint();
    f.dispose(); await showing;
    assert.equal(f.frames.pending, 0, "unload cancels the queued RAF and settles show()");
    assert.equal(f.instances().length, 0);
  }
}

async function persistenceAndNavigation(): Promise<void> {
  for (const action of ["dismiss", "choose"] as const) {
    const f = fixture(); const modal = await f.open();
    f.state.saveError = true;
    const invoke = () => action === "dismiss" ? modal.options.onDismiss() : modal.options.onChoose("knowledge");
    await assert.rejects(invoke(), /SAVE_FAILED/);
    assert.equal(f.plugin.settings.setup.paperGuideDismissedAt, 0, "failed persistence rolls back memory");
    assert.equal(f.state.saved, undefined); assert.equal(modal.closed, false);
    assert.equal(f.listCalls.length, 0);
    f.state.saveError = false;
    const next = await invoke();
    assert.ok(f.plugin.settings.setup.paperGuideDismissedAt > 0);
    assert.equal(f.listCalls.length, 0, "selection returns navigation without running it");
    modal.close();
    if (typeof next === "function") await next();
    assert.equal(f.listCalls.length, action === "choose" ? 1 : 0);
    assert.equal(f.executionCalls.length, 0);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.registryListeners.size, 0);
    assert.deepEqual(f.state.saveArguments.at(-1), [true, { flushConversationStore: false }]);
    f.dispose();
    f.plugin.settings = normalizeSettingsData(f.state.saved).settings;
    const restarted = f.newController();
    await restarted.showAfterOnboarding();
    assert.equal(f.instances().length, 1, "normalization and a new controller preserve completion");
    assert.equal(f.frames.pending, 0); f.dispose();
  }
  const f = fixture(); const modal = await f.open();
  f.state.saveGate = deferred();
  let resolved = false;
  const chosen = modal.options.onChoose("knowledge").then(next => { resolved = true; return next; });
  await Promise.resolve();
  assert.equal(resolved, false); assert.deepEqual(f.events, ["save:start"]);
  f.state.saveGate.resolve(); const next = await chosen;
  assert.equal(typeof next, "function");
  assert.deepEqual(f.events, ["save:start", "save:done"]);
  modal.close(); f.dispose();
  if (typeof next === "function") await next();
  assert.equal(f.listCalls.length, 0, "unloading cancels deferred navigation");

  const legacy = normalizeSettingsData({ setup: { completedAt: 5 } }).settings;
  assert.equal(legacy.setup.paperGuideDismissedAt, 0);
  for (const invalid of [-1, "yesterday", null]) {
    assert.equal(normalizeSettingsData({ setup: { paperGuideDismissedAt: invalid } }).settings.setup.paperGuideDismissedAt, 0);
  }
}

async function repeatedOnboardingCompletion(): Promise<void> {
  for (const action of ["dismiss", "choose"] as const) {
    const f = fixture();
    assert.equal(f.instances().length, 0, "visiting Home does not automatically open the guide");
    for (let round = 1; round <= 3; round++) {
      if (round > 1) {
        const setup = f.plugin.settings.setup;
        assert.ok(prepareEchoInkOnboardingTutorial(setup, { forceRestart: true }));
        for (const step of ECHOINK_ONBOARDING_STEPS) {
          await f.controller.showAfterOnboarding();
          assert.equal(f.instances().length, round - 1, "an unfinished tutorial cannot reopen the guide");
          const result = advanceEchoInkOnboardingTutorial(setup, step, Date.now() + round);
          assert.equal(result.completed, step === ECHOINK_ONBOARDING_STEPS.at(-1));
        }
      }
      const modal = await f.open();
      assert.equal(f.instances().length, round, `${action}: completing tutorial ${round} opens a fresh guide`);
      await f.controller.showAfterOnboarding();
      assert.equal(f.instances().length, round, "repeated completion calls do not stack dialogs");
      const next = action === "dismiss" ? await modal.options.onDismiss() : await modal.options.onChoose("knowledge");
      modal.close();
      if (typeof next === "function") await next();
      assert.ok(f.plugin.settings.setup.paperGuideDismissedAt > 0);
      assert.equal(f.state.saves, round, "each tutorial's guide choice or dismissal is saved");
      await f.controller.showAfterOnboarding();
      assert.equal(f.instances().length, round, "a closed guide stays closed for the same tutorial completion");
      assert.equal(f.frames.pending, 0);
      assert.equal(f.listeners.size, 0);
    }
    assert.equal(f.listCalls.length, action === "choose" ? 3 : 0);
    assert.equal(f.executionCalls.length, 0);
    f.dispose();
  }
}

async function scenarioRouting(): Promise<void> {
  const targets = [
    ["english", "english-diary", "english-owner", "英语同事", "我想用日记练习英语，先帮我看看今天的日记。", "I'd like to practice English with my diary. First, help me look at today's entry."],
    ["finance", "finance", "finance-owner", "财务同事", "帮我看看本月的收支和预算，先告诉我有哪些值得留意的地方。", "Help me review this month's spending, income and budget. First, tell me what deserves attention."],
    ["knowledge", "knowledge-base", "knowledge-owner", "知识同事", "帮我看看有哪些笔记适合整理，先给我一个方案。", "Help me find notes that would benefit from organizing. Give me a plan first."]
  ] as const;
  for (const [scene, module, ownerId, ownerName, prompt, englishPrompt] of targets) {
    const conditions = scene === "knowledge" ? [{ paid: false, enabled: false }]
      : [false, true].flatMap(paid => [false, true].map(enabled => ({ paid, enabled })));
    for (const condition of conditions) {
      const f = fixture(condition); const modal = await f.open();
      const item = modal.scenes.find(item => item.id === scene)!;
      const before = structuredClone({ english: f.plugin.settings.englishDiary, lifestyle: f.plugin.settings.lifestyle, agents: f.plugin.settings.agentRegistry, sessions: f.plugin.settings.sessions });
      assert.equal(modal.scenes.length, 3); assert.ok(item.description.includes(ownerName));
      assert.ok(item.description.includes("仅预填")); assert.doesNotMatch(item.description, /进入.*工作区|启用后开始使用/u);
      assert.equal(item.badge, scene === "knowledge" ? undefined : "PRO");
      if (scene !== "knowledge") {
        assert.equal(item.description.includes("需要 PRO"), !condition.paid);
        assert.equal(item.description.includes(scene === "english" ? "需先启用英文日记" : "需先启用财务"), !condition.enabled);
        if (condition.paid && !condition.enabled) assert.equal(item.description,
          `交给 ${ownerName}，仅预填 · ${scene === "english" ? "需先启用英文日记" : "需先启用财务"}`,
          "an existing PRO member with a disabled module only needs the enablement reminder");
      }
      const next = await modal.options.onChoose(scene);
      assert.equal(typeof next, "function"); assert.deepEqual(f.events, ["save:start", "save:done"]);
      assert.equal(f.listCalls.length, 0, "no navigation before persisted dismissal and native close");
      modal.close(); if (typeof next === "function") await next();
      assert.deepEqual(f.listCalls, [[ownerId, prompt]], `${scene}: only the actual owner and approved text reach the launcher`);
      assert.deepEqual(f.navigation.page, { kind: "list", agentId: ownerId });
      assert.deepEqual(f.navigation.draft(), { text: prompt, attachments: [] }, "real task navigation stores only an editable prefill");
      assert.deepEqual({ english: f.plugin.settings.englishDiary, lifestyle: f.plugin.settings.lifestyle, agents: f.plugin.settings.agentRegistry, sessions: f.plugin.settings.sessions }, before, "selection cannot enable modules, alter rights, create tasks or write source content");
      assert.deepEqual(f.executionCalls, []); f.dispose();
    }

    for (const change of ["reassigned", "deleted"] as const) {
      const f = fixture({ enabled: false, paid: false }); const modal = await f.open();
      if (change === "reassigned") {
        f.setOwner(module, "sol");
        assert.equal(modal.updates, 1);
        assert.ok(modal.scenes.find(item => item.id === scene)?.description.includes("总助"), "visible owner updates from the real registry event");
      }
      const next = await modal.options.onChoose(scene); modal.close();
      if (change === "reassigned") {
        f.plugin.settings.agentRegistry.agents.push({ ...structuredClone(f.plugin.settings.agentRegistry.agents[0]), id: "late-owner", name: "最后换的同事" });
        f.setOwner(module, "late-owner");
      } else f.plugin.settings.agentRegistry.agents = f.plugin.settings.agentRegistry.agents.filter(agent => agent.id !== ownerId);
      if (typeof next === "function") await next();
      assert.deepEqual(f.listCalls, [[change === "reassigned" ? "late-owner" : "sol", prompt]], "the action reads the latest owner after closing; deleted owners fall back to Sol");
      assert.deepEqual(f.executionCalls, []); assert.equal(f.registryListeners.size, 0); f.dispose();
    }

    const protectedDraft = fixture();
    protectedDraft.navigation.navigate({ kind: "list", agentId: ownerId });
    protectedDraft.navigation.save({ text: "尚未发送的原内容", attachments: [{ type: "file", name: "合成.md", path: "合成.md" }], noteMentions: [{ vaultRelativePath: "引用.md", fileName: "引用.md" }] });
    const original = protectedDraft.navigation.draft();
    const protectedModal = await protectedDraft.open(); const protectedNext = await protectedModal.options.onChoose(scene); protectedModal.close();
    if (typeof protectedNext === "function") await protectedNext();
    assert.deepEqual(protectedDraft.navigation.draft(), original, `${scene}: the real P3 draft boundary preserves unsent text and references`);
    assert.deepEqual(protectedDraft.executionCalls, []); protectedDraft.dispose();

    const english = fixture({ language: "en", enabled: false, paid: false });
    const englishModal = await english.open(); assert.equal(englishModal.options.language, "en");
    const description = englishModal.scenes.find(item => item.id === scene)!.description;
    assert.ok(description.includes(`Prepare a draft for ${ownerName}`));
    if (scene !== "knowledge") { assert.ok(description.includes("PRO required")); assert.ok(description.includes("first")); }
    const englishNext = await englishModal.options.onChoose(scene); englishModal.close();
    if (typeof englishNext === "function") await englishNext();
    assert.deepEqual(english.listCalls, [[ownerId, englishPrompt]]); assert.deepEqual(english.executionCalls, []); english.dispose();
  }

  const live = fixture({ enabled: false, paid: true }); const liveModal = await live.open();
  live.setPaid(false); assert.ok(liveModal.scenes.find(item => item.id === "english")?.description.includes("需要 PRO"));
  live.setPaid(true); assert.equal(liveModal.scenes.find(item => item.id === "english")?.description.includes("需要 PRO"), false);
  assert.ok(liveModal.scenes.find(item => item.id === "english")?.description.includes("需先启用英文日记")); live.dispose();
  const missingAccount = fixture({ enabled: false }); missingAccount.plugin.accountService = null;
  const missingModal = await missingAccount.open(); assert.ok(missingModal.scenes.find(item => item.id === "finance")?.description.includes("需要 PRO"));
  const missingNext = await missingModal.options.onChoose("finance"); missingModal.close(); if (typeof missingNext === "function") await missingNext();
  assert.equal(missingAccount.listCalls[0]?.[0], "finance-owner"); assert.deepEqual(missingAccount.executionCalls, []); missingAccount.dispose();
  const failed = fixture(); const failedModal = await failed.open(); failed.state.listError = true;
  const failedNext = await failedModal.options.onChoose("knowledge"); failedModal.close();
  if (typeof failedNext === "function") await assert.rejects(failedNext(), /TASK_LIST_FAILED/);
  assert.ok(failed.plugin.settings.setup.paperGuideDismissedAt > 0); assert.deepEqual(failed.executionCalls, []); failed.dispose();
}

async function ordinaryHomeAndSkip(): Promise<void> {
  const f = fixture();
  for (let round = 0; round < 3; round++) { f.frames.paint(); await Promise.resolve(); }
  assert.equal(f.instances().length, 0, "a controller on ordinary Home does not register an automatic guide trigger");
  assert.equal(f.frames.pending, 0); assert.equal(f.listeners.size, 0); assert.equal(f.registryListeners.size, 0);
  assert.ok(prepareEchoInkOnboardingTutorial(f.plugin.settings.setup, { forceRestart: true }));
  dismissEchoInkOnboardingTutorial(f.plugin.settings.setup);
  await f.controller.showAfterOnboarding();
  assert.equal(f.instances().length, 0, "skipping an unfinished tutorial cannot show Paper Guide");
  assert.equal(f.state.saves, 0); assert.deepEqual(f.listCalls, []); assert.deepEqual(f.executionCalls, []); f.dispose();
}

interface CompletionOptions {
  onAction: () => Promise<void>;
  onDismiss: () => Promise<void>;
}
interface CompletionFixture {
  plugin: { settings: { settingsLanguage: string }; activateHomeAndSidebar: () => Promise<void>; openPaperGuideAfterOnboarding: () => Promise<void> };
  app: { setting: { close: () => void } };
  containerEl: object;
  clearOnboardingCoachmark: (restore: boolean) => void;
  showOnboardingCompletion(): void;
}

export async function runPaperGuideCompletionTests(Constructor: new () => CompletionFixture, options: () => CompletionOptions): Promise<void> {
  for (const callback of ["onAction", "onDismiss"] as const) {
    const events: string[] = []; const home = deferred(); const f = new Constructor();
    f.containerEl = {};
    f.plugin = { settings: { settingsLanguage: "zh-CN" },
      activateHomeAndSidebar: async () => { events.push("home:start"); await home.promise; events.push("home:ready"); },
      openPaperGuideAfterOnboarding: async () => { events.push("paper-guide"); }
    };
    f.app = { setting: { close: () => { events.push("settings:close"); } } };
    f.clearOnboardingCoachmark = restore => { assert.equal(restore, false); events.push("coachmark:clear"); };
    f.showOnboardingCompletion(); events.length = 0;
    const returning = options()[callback]();
    assert.deepEqual(events, ["home:start"], "completion waits for the actual Home navigation");
    home.resolve(); await returning;
    assert.deepEqual(events, ["home:start", "home:ready", "coachmark:clear", "settings:close", "paper-guide"]);
  }
  const events: string[] = []; const f = new Constructor();
  f.containerEl = {};
  f.plugin = { settings: { settingsLanguage: "en" },
    activateHomeAndSidebar: async () => { throw new Error("HOME_FAILED"); },
    openPaperGuideAfterOnboarding: async () => { events.push("paper-guide"); }
  };
  f.app = { setting: { close: () => { events.push("settings:close"); } } };
  f.clearOnboardingCoachmark = () => { events.push("coachmark:clear"); };
  f.showOnboardingCompletion(); events.length = 0;
  await assert.rejects(options().onAction(), /HOME_FAILED/);
  assert.deepEqual(events, [], "failed Home navigation leaves completion retryable");
  console.log("PASS paper guide completion: production action/dismiss ordering and navigation failure");
}

export async function runPaperGuideTests(): Promise<void> {
  await timingAndCancellation();
  await persistenceAndNavigation();
  await repeatedOnboardingCompletion();
  await scenarioRouting();
  await ordinaryHomeAndSkip();
  console.log("PASS paper guide controller: paint timing, persisted dismissal/rollback, repeated completion, three latest-owner prefills, real draft protection, zero execution, live requirement copy and ordinary Home/skip silence");
}
