import type { KnowledgeMaintenancePreferenceSnapshot } from "../knowledge-base/knowledge-maintenance-preferences";
import assert from "node:assert/strict";
import { Platform } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { PaperGuideController } from "../plugin/paper-guide-controller";
import { activateApiProvider, createApiProviderConfig } from "../settings/settings";
import { emptyKnowledgeFolderBindings as emptyKnowledgeFolderBindingsForTests } from "../knowledge-base/folder-bindings";
import { normalizeSettingsData } from "../settings/settings";
import { PaperGuideModal } from "./paper-guide-modal-shim";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
class Frames {
  private callbacks = new Map<number, FrameRequestCallback>();
  private next = 0;
  requestAnimationFrame = (callback: FrameRequestCallback) => { this.callbacks.set(++this.next, callback); return this.next; };
  cancelAnimationFrame = (id: number) => { this.callbacks.delete(id); };
  paint() { const entries = [...this.callbacks]; this.callbacks.clear(); for (const [, callback] of entries) callback(0); }
}
function fixture() {
  const frames = new Frames();
  const document = { defaultView: frames, hidden: false, querySelector: () => null };
  const home = { ownerDocument: document, isConnected: true, getClientRects: () => [{}] };
  const settings = normalizeSettingsData({ setup: { completedAt: 1 } }).settings;
  let requested = false, saves = 0, tests = 0, activations = 0, manual = 0, tries = 0;
  let connection: "available" | "failed" = "failed";
  let saveFails = false;
  const plugin = { app: {}, settings,
    getEchoInkKnowledgeMaintenancePreferenceState: async (): Promise<KnowledgeMaintenancePreferenceSnapshot> => ({
      state: "custom", revision: "fixture", content: "已有自定义",
      profileVersion: "echoink-knowledge-preference-profile-v1",
    }),
    isEchoInkOnboardingRequested: () => requested,
    getKnowledgeSurfaceService: () => ({ previewOnboardingSetupPlan: async () => ({ marker: true }), applyOnboardingSetupPlan: async () => ({ configured: true }) }),
    async saveSettings() { if (saveFails) throw new Error("SAVE_FAILED"); saves++; },
    async testPiProviderConnection(draft: { modelId: string; apiKey: string }) {
      tests++; assert.equal(draft.modelId, "deepseek-v4-flash"); assert.equal(draft.apiKey, "fixture-key");
      return connection === "available" ? { status: "available" as const } : { status: "failed" as const, failure: "auth" as const };
    },
    async activateApiProviderSettings(change: (value: typeof settings) => void) { activations++; change(settings); },
    async openEchoInkKnowledgeInitializationSettings() { manual++; },
    async openAgentTaskList(id: string, text: string) { tries++; assert.equal(id, "sol"); assert(text.includes("总结")); return false; }
  };
  const controller = new PaperGuideController(plugin as unknown as CodexForObsidianPlugin, () => home as unknown as HTMLElement);
  const begin = PaperGuideModal.instances.length;
  const open = async () => { const count = PaperGuideModal.instances.length; const pending = controller.showAfterOnboarding(); frames.paint(); frames.paint(); await pending; return PaperGuideModal.instances.length > count ? PaperGuideModal.instances.slice(begin).at(-1) : undefined; };
  return { plugin, controller, open, setRequested: (value: boolean) => { requested = value; }, setSaveFailure: (value: boolean) => { saveFails = value; },
    setConnection: (value: "available" | "failed") => { connection = value; }, counts: () => ({ saves, tests, activations, manual, tries }) };
}
export async function runPaperGuideTests(): Promise<void> {
  Platform.isDesktopApp = true;
  const f = fixture(); const dialog = await f.open(); assert(dialog?.opened);
  const instanceCount = PaperGuideModal.instances.length;
  assert.equal(await f.open(), undefined); assert.equal(PaperGuideModal.instances.length, instanceCount);
  const providersBefore = structuredClone(f.plugin.settings.apiProviders);
  await dialog.options.connect("deepseek", "");
  assert.deepEqual(f.counts(), { saves: 0, tests: 0, activations: 0, manual: 0, tries: 0 });
  const failed = await dialog.options.connect("deepseek", "fixture-key");
  assert.equal(failed.available, false); assert(failed.message.length > 0);
  assert.deepEqual(f.plugin.settings.apiProviders, providersBefore);
  assert.equal(f.counts().tests, 1); assert.equal(f.counts().activations, 0);
  f.setConnection("available"); await dialog.options.connect("deepseek", "fixture-key");
  assert.equal(f.counts().tests, 2); assert.equal(f.counts().activations, 1); assert(dialog.options.model());
  assert.equal(await dialog.options.onTry(), false); assert.equal(f.counts().tries, 1);
  const business = structuredClone({ providers: f.plugin.settings.apiProviders, bindings: f.plugin.settings.knowledgeBase.folderBindings });
  await dialog.options.onManual(); assert.equal(f.counts().manual, 1);
  assert.deepEqual({ providers: f.plugin.settings.apiProviders, bindings: f.plugin.settings.knowledgeBase.folderBindings }, business);
  f.setSaveFailure(true); await assert.rejects(dialog.options.onDismiss(), /SAVE_FAILED/);
  assert.equal(f.plugin.settings.setup.paperGuideDismissedAt, 0);
  f.setSaveFailure(false); await dialog.options.onDismiss(); assert(f.plugin.settings.setup.paperGuideDismissedAt > 0);
  dialog.close(); assert.equal(await f.open(), undefined);
  await f.controller.showManually(); assert(PaperGuideModal.instances.at(-1)?.opened, "manual entry bypasses dismissal");
  f.controller.dispose();

  for (const state of ["incomplete", "dismissed", "tutorial", "configured", "legacy-projects"] as const) {
    const item = fixture();
    if (state === "incomplete") item.plugin.settings.setup.completedAt = 0;
    if (state === "dismissed") item.plugin.settings.setup.paperGuideDismissedAt = 10;
    if (state === "tutorial") item.setRequested(true);
    if (state === "configured" || state === "legacy-projects") {
      const bindings = emptyKnowledgeFolderBindingsForTests(); bindings.configured = false;
      for (const [role, folder] of [["raw", "资料"], [state === "legacy-projects" ? "projects" : "wiki", "知识"]] as const) Object.assign(bindings.roles[role], { enabled: true, readPaths: [folder], writePath: folder });
      item.plugin.settings.knowledgeBase.folderBindings = bindings;
      const provider = createApiProviderConfig(); provider.apiKey = "fixture-key";
      item.plugin.settings.apiProviders = [provider]; activateApiProvider(item.plugin.settings, provider);
      item.plugin.settings.knowledgeBase.initialized = false;
    }
    assert.equal(await item.open(), undefined, state); item.controller.dispose();
  }
  const preferencesOnly = fixture();
  const readyBindings = emptyKnowledgeFolderBindingsForTests();
  for (const [role, folder] of [["raw", "资料"], ["wiki", "知识"]] as const)
    Object.assign(readyBindings.roles[role], { enabled: true, readPaths: [folder], writePath: folder });
  preferencesOnly.plugin.settings.knowledgeBase.folderBindings = readyBindings;
  const readyProvider = createApiProviderConfig();
  readyProvider.apiKey = "fixture-key";
  preferencesOnly.plugin.settings.apiProviders = [readyProvider];
  activateApiProvider(preferencesOnly.plugin.settings, readyProvider);
  preferencesOnly.plugin.getEchoInkKnowledgeMaintenancePreferenceState = async () => ({
    state: "default", revision: "fixture", content: "默认偏好",
    profileVersion: "echoink-knowledge-preference-profile-v1",
  });
  assert.equal(await preferencesOnly.open(), undefined, "Existing ready directories never trigger a purpose question");
  preferencesOnly.plugin.settings.apiProviders = [];
  assert.equal(await preferencesOnly.open(), undefined, "Missing models do not turn an existing library into a new user");
  preferencesOnly.controller.dispose();

  const initialized = fixture(); initialized.plugin.settings.knowledgeBase.initialized = true;
  assert(await initialized.open(), "dismissed reminders do not imply configured directories"); initialized.controller.dispose();
  console.log("PASS setup controller: auto/manual truth, blank-key zero writes, single connection call, failure isolation, activation, dismissal rollback, manual navigation and false-prefill result");
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
