import assert from "node:assert/strict";
import type CodexForObsidianPlugin from "../main";
import type { CapabilityAccess } from "../membership/types";
import { PaperGuideController } from "../plugin/paper-guide-controller";
import {
  advanceEchoInkOnboardingTutorial,
  ECHOINK_ONBOARDING_STEPS,
  prepareEchoInkOnboardingTutorial
} from "../settings/onboarding";
import { normalizeSettingsData } from "../settings/settings";
import { PaperGuideModal } from "./paper-guide-modal-shim";

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
  const events: string[] = [];
  const state = {
    saved: undefined as unknown,
    saves: 0,
    saveError: false,
    saveGate: null as ReturnType<typeof deferred> | null,
    enableError: false,
    saveArguments: [] as unknown[][]
  };
  const plugin = {
    app: {}, settings, accountService: access as CapabilityAccess | null,
    isEchoInkOnboardingRequested: () => requested,
    async saveSettings(...args: unknown[]) {
      events.push("save:start"); state.saves++; state.saveArguments.push(args);
      if (state.saveGate) await state.saveGate.promise;
      if (state.saveError) throw new Error("SAVE_FAILED");
      state.saved = structuredClone(plugin.settings);
      events.push("save:done");
    },
    englishDiary: {
      async setEnabled(enabled: boolean) {
        events.push("english:enable");
        if (state.enableError) throw new Error("ENABLE_FAILED");
        plugin.settings.englishDiary.enabled = enabled;
      },
      async openToday() { events.push("english:open"); }
    },
    lifestyle: {
      async setEnabled(kind: string, enabled: boolean) {
        assert.equal(kind, "finance"); events.push("finance:enable");
        if (state.enableError) throw new Error("ENABLE_FAILED");
        plugin.settings.lifestyle.finance.enabled = enabled;
      },
      async open(kind: string) { assert.equal(kind, "finance"); events.push("finance:open"); }
    },
    async openEchoInkKnowledgeSettings() { events.push("knowledge:open"); },
    async openEchoInkAccountSettings() { events.push("account:open"); }
  };
  const controllers: PaperGuideController[] = [];
  const newController = () => {
    const controller = new PaperGuideController(plugin as unknown as CodexForObsidianPlugin, () => activeHome as HTMLElement | null);
    controllers.push(controller);
    return controller;
  };
  const controller = newController();
  const initialInstances = PaperGuideModal.instances.length;
  return {
    frames, document, home, plugin, state, events, listeners, controller, newController,
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
  f.dispose();
  assert.equal(f.listeners.size, 0); assert.equal(f.instances()[0].disposed, true);
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
    assert.ok(!f.events.includes("knowledge:open"));
    f.state.saveError = false;
    const next = await invoke();
    assert.ok(f.plugin.settings.setup.paperGuideDismissedAt > 0);
    assert.ok(!f.events.includes("knowledge:open"), "selection returns navigation without running it");
    modal.close();
    if (typeof next === "function") await next();
    assert.equal(f.events.includes("knowledge:open"), action === "choose");
    assert.equal(f.listeners.size, 0);
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
  assert.ok(!f.events.includes("knowledge:open"), "unloading cancels deferred navigation");

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
          assert.equal(result.completed, step === "personality");
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
    assert.equal(f.events.filter(event => event === "knowledge:open").length, action === "choose" ? 3 : 0);
    f.dispose();
  }
}

async function scenarioRouting(): Promise<void> {
  for (const scene of ["english", "finance"] as const) for (const paid of [false, true]) for (const enabled of [false, true]) {
    const f = fixture({ paid, enabled }); const modal = await f.open();
    const item = modal.scenes.find(item => item.id === scene)!;
    assert.equal(modal.scenes.length, 3);
    assert.equal(item.badge, "PRO");
    if (!paid) assert.equal(item.description, enabled ? "查看已有记录" : "查看 PRO 权益");
    else if (!enabled) assert.equal(item.description, "启用后开始使用");
    const next = await modal.options.onChoose(scene);
    assert.equal(typeof next, "function");
    assert.deepEqual(f.events, ["save:start", "save:done"]);
    modal.close(); if (typeof next === "function") await next();
    const expected = !paid && !enabled ? ["account:open"]
      : enabled ? [`${scene}:open`] : [`${scene}:enable`, `${scene}:open`];
    assert.deepEqual(f.events.slice(2), expected, `${scene}: paid=${paid}, enabled=${enabled}`);
    f.dispose();
  }
  for (const scene of ["english", "finance"] as const) {
    const f = fixture({ paid: true, enabled: false }); const modal = await f.open();
    f.setPaid(false);
    assert.equal(modal.updates, 1);
    assert.equal(modal.scenes.find(item => item.id === scene)?.description, "查看 PRO 权益");
    f.setPaid(true);
    assert.equal(modal.scenes.find(item => item.id === scene)?.description, "启用后开始使用");
    const next = await modal.options.onChoose(scene);
    modal.close(); f.setPaid(false);
    if (typeof next === "function") await next();
    assert.deepEqual(f.events.slice(2), ["account:open"], "navigation rechecks access after choice and close");
    f.dispose();

    const failure = fixture({ paid: true, enabled: false }); const failedModal = await failure.open();
    failure.state.enableError = true;
    const failedNext = await failedModal.options.onChoose(scene);
    failedModal.close(); assert.equal(typeof failedNext, "function");
    if (typeof failedNext === "function") await assert.rejects(failedNext(), /ENABLE_FAILED/);
    assert.ok(!failure.events.includes(`${scene}:open`), "failed enabling never opens the module");
    failure.dispose();
  }
  for (const scene of ["knowledge", "english"] as const) {
    const f = fixture({ enabled: false }); f.plugin.accountService = null;
    const modal = await f.open(); const next = await modal.options.onChoose(scene);
    modal.close(); if (typeof next === "function") await next();
    assert.deepEqual(f.events.slice(2), [scene === "knowledge" ? "knowledge:open" : "account:open"]);
    assert.equal(f.listeners.size, 0); f.dispose();
  }
  const english = fixture({ language: "en", enabled: false, paid: false });
  const modal = await english.open();
  assert.equal(modal.options.language, "en");
  assert.equal(modal.scenes.find(item => item.id === "english")?.description, "View PRO access");
  english.dispose();
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
  console.log("PASS paper guide controller: paint timing, single instance, cancellation, persisted dismissal, repeated tutorial completion, rollback, 8 access routes and live authorization");
}
