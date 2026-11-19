import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, apiProviderHasUsableCredential, createApiProviderConfig, createApiProviderModelConfig, ensureXiaoechoProvider, getActiveApiProviderModel, normalizeSettingsData, setEchoInkAccountCredentialProbe } from "../settings/settings";
import { listXiaoechoModels, parseXiaoechoCatalog, xiaoechoDiscoveredModels, XIAOECHO_CATALOG_MAX_AGE_MS, type XiaoechoModelFetch } from "../membership/xiaoecho-catalog";
import { normalizeXiaoechoTypicalPoints, xiaoechoDesktopModelName, xiaoechoTypicalPointsLabel } from "../membership/xiaoecho-points";
import { normalizeDiscoveredProviderModel } from "../settings/provider-model-discovery";
import { filterXiaoechoProviderDraft, repairXiaoechoModelSelection } from "../membership/xiaoecho-catalog-state";
import { publishXiaoechoModelSignal } from "../membership/xiaoecho-model-signal";
import { XiaoechoCatalogService } from "../plugin/xiaoecho-catalog-service";
import { settingsForRunningXiaoechoModel } from "../plugin/xiaoecho-running-provider";
import CodexForObsidianPlugin from "../main";
import { ApiProviderActivationService, ProductActivityGate } from "../plugin/api-provider-activation-service";
import { snapshotApiProviderSettings } from "../plugin/settings-store";

const catalog = () => ({ auto: { id: "auto", typicalPoints: "3.85" }, vendors: [{ vendor: "Fixture", models: [
  { id: "available", label: "Available", multiplier: 5, enabled: true, typicalPoints: "0.78" },
  { id: "disabled", label: "Disabled", multiplier: 1, enabled: false }
] }], enabled: true });
function fixture(id: string) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const echo = createApiProviderConfig("xiaoecho", `echo-${id}`);
  echo.baseUrl = `https://${id}.invalid/api/xiaoecho`;
  echo.models.push(...["deleted", "disabled", "available"].map(id => createApiProviderModelConfig("xiaoecho", id)));
  echo.defaultModelId = "deleted";
  const other = createApiProviderConfig("deepseek", `other-${id}`);
  settings.apiProviders = [echo, other]; settings.providerMode = "custom-api";
  settings.activeApiProviderId = echo.id; settings.defaultModel = "deleted";
  settings.taskWorkspace.newTaskDrafts.sol = { text: "Keep my draft", attachments: [], selectedProviderSettingsId: echo.id, selectedModel: "disabled" };
  settings.taskWorkspace.replyDrafts.other = { text: "Other", attachments: [], selectedProviderSettingsId: other.id, selectedModel: other.models[0].id };
  return { settings, echo, other };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.fail("catalog work did not settle");
}
function typicalPointsTests(): void {
  const label = (value: string, language = "zh") => xiaoechoTypicalPointsLabel({ discovery: { typicalPoints: value } }, language);
  for (const [value, expected] of [
    ["0", "0"], ["0.00", "0"], ["0.01", "0.01"], ["0.10", "0.1"], ["0.78", "0.78"],
    ["0.99", "0.99"], ["1.00", "1"], ["1.04", "1"], ["1.05", "1.1"], ["1.15", "1.2"],
    ["3.85", "3.9"], ["3.90", "3.9"], ["9.95", "10"], ["10.00", "10"]
  ]) {
    assert.equal(normalizeXiaoechoTypicalPoints(value), value);
    assert.equal(label(value), `约 ${expected} 点/次`, value);
    assert.equal(label(value, "en"), `~${expected} pts/msg`, value);
  }
  assert.equal(xiaoechoTypicalPointsLabel({}, "en"), undefined);
  for (const invalid of [undefined, null, "", " ", " 1.05", "1.05 ", "1\n", "-1", "-0", "NaN", "Infinity", "1e2", "1e-999", ".5", "1.", "1.005", "9".repeat(400), 0, 1.05, {}, []]) {
    assert.equal(normalizeXiaoechoTypicalPoints(invalid), undefined, String(invalid));
    assert.equal(xiaoechoTypicalPointsLabel({ discovery: { typicalPoints: invalid as string } }, "en"), undefined);
    const withInvalidPoints = catalog();
    Object.assign(withInvalidPoints.vendors[0].models[0], { typicalPoints: invalid });
    const parsed = parseXiaoechoCatalog(withInvalidPoints);
    assert.ok(parsed, "invalid optional points cannot reject the catalog");
    assert.equal(parsed.auto.typicalPoints, "3.85", "a model's invalid points cannot affect another model");
    assert.equal(parsed.vendors[0].models[0].typicalPoints, undefined);
    assert.deepEqual(xiaoechoDiscoveredModels(parsed).map(model => model.id), ["auto", "available"]);
    Object.assign(withInvalidPoints.auto, { typicalPoints: invalid });
    assert.equal(parseXiaoechoCatalog(withInvalidPoints)?.auto.typicalPoints, undefined);
    assert.deepEqual(normalizeDiscoveredProviderModel({ id: "valid", typicalPoints: invalid }), { id: "valid" }, "invalid points cannot reject a saved model");
  }
  const legacy = catalog();
  delete (legacy.auto as { typicalPoints?: string }).typicalPoints;
  delete legacy.vendors[0].models[0].typicalPoints;
  const parsedLegacy = parseXiaoechoCatalog(legacy);
  assert.ok(parsedLegacy, "old servers without points still provide a complete catalog");
  assert.ok(xiaoechoDiscoveredModels(parsedLegacy).every(model => model.typicalPoints === undefined));

  assert.equal(xiaoechoDesktopModelName("xiaoecho", { id: "available", displayName: "Available ×5" }), "Available");
  assert.equal(xiaoechoDesktopModelName("xiaoecho", { id: "available", displayName: "Available ×0.7" }), "Available");
  assert.equal(xiaoechoDesktopModelName("xiaoecho", { id: "auto", displayName: "auto ×1" }), "auto");
  assert.equal(xiaoechoDesktopModelName("xiaoecho", { id: "available" }), "available");
  assert.equal(xiaoechoDesktopModelName("deepseek", { id: "available", displayName: "Available ×5" }), "Available ×5");
  assert.equal(xiaoechoDesktopModelName("xiaoecho", { id: "available", displayName: "Available ×5 preview" }), "Available ×5 preview");
}
function autoAddAfterSignInTests(): void {
  setEchoInkAccountCredentialProbe(() => true);
  // 只有一个没填 Key 的服务：补上小echo 并设为默认。
  const fresh = structuredClone(DEFAULT_SETTINGS);
  fresh.apiProviders = [createApiProviderConfig("deepseek", "keyless")]; fresh.activeApiProviderId = ""; fresh.defaultModel = "";
  assert.equal(ensureXiaoechoProvider(fresh), true);
  const added = fresh.apiProviders.find(provider => provider.providerId === "xiaoecho");
  assert.ok(added);
  assert.equal(fresh.activeApiProviderId, added.id);
  assert.equal(fresh.defaultModel, added.defaultModelId);
  assert.equal(getActiveApiProviderModel(fresh)?.provider.id, added.id);
  assert.equal(ensureXiaoechoProvider(fresh), false, "second run is a no-op");
  assert.equal(fresh.apiProviders.filter(provider => provider.providerId === "xiaoecho").length, 1);
  // 已有能用的默认模型：只补上小echo，不改默认。
  const own = structuredClone(DEFAULT_SETTINGS);
  const keyed = createApiProviderConfig("deepseek", "keyed"); keyed.apiKey = "fixture-key";
  own.apiProviders = [keyed]; own.providerMode = "custom-api"; own.activeApiProviderId = keyed.id; own.defaultModel = keyed.defaultModelId;
  assert.equal(ensureXiaoechoProvider(own), true);
  assert.equal(own.apiProviders.some(provider => provider.providerId === "xiaoecho"), true);
  assert.equal(own.activeApiProviderId, keyed.id);
  assert.equal(own.defaultModel, keyed.defaultModelId);
}
export async function runXiaoechoCatalogTests(): Promise<void> {
  autoAddAfterSignInTests();
  const originalWindow = globalThis.window;
  globalThis.window ??= globalThis as unknown as Window & typeof globalThis;
  try {
    typicalPointsTests();
    const restoring = fixture("catalog-account-restoration");
    setEchoInkAccountCredentialProbe(() => false);
    const loadedBeforeAccount = normalizeSettingsData(restoring.settings).settings;
    assert.equal(loadedBeforeAccount.activeApiProviderId, restoring.echo.id, "account initialization cannot switch the saved xiaoecho Provider to another service");
    assert.equal(loadedBeforeAccount.defaultModel, "deleted");
    assert.equal(apiProviderHasUsableCredential(loadedBeforeAccount.apiProviders[0], null), false, "retaining the selection does not grant account authentication");
    const { settings, echo, other } = fixture("catalog-success");
    const admitted = structuredClone(echo);
    const staleEditor = structuredClone(echo);
    let fetches = 0, writes = 0, notices = 0;
    let persisted = structuredClone(settings);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl: XiaoechoModelFetch = async () => { fetches++; await pending; return { status: 200, json: async () => catalog() }; };
    const service = new XiaoechoCatalogService({ settings, token: () => "fixture-token", persist: async () => {
      writes++; persisted = normalizeSettingsData(JSON.parse(JSON.stringify(settings))).settings;
    }, notifyModelRetired: () => { notices++; } }, fetchImpl);
    try {
      const first = service.refresh(true), second = service.refresh(true);
      const editor = listXiaoechoModels({ baseUrl: echo.baseUrl, token: "fixture-token", fetchImpl, timeoutMs: 1000 });
      release(); await Promise.all([first, second, editor]);
      assert.equal(fetches, 1, "startup, editor and menu share the same in-flight GET");
      assert.deepEqual(echo.models.map(model => model.id), ["auto", "available"]);
      assert.equal(echo.defaultModelId, "auto"); assert.equal(settings.defaultModel, "auto");
      assert.equal(settings.activeApiProviderId, echo.id);
      assert.equal(settings.taskWorkspace.newTaskDrafts.sol.selectedModel, "auto");
      assert.equal(settings.taskWorkspace.newTaskDrafts.sol.text, "Keep my draft");
      assert.equal(settings.taskWorkspace.replyDrafts.other.selectedModel, other.models[0].id);
      assert.deepEqual(persisted.apiProviders[0].models.map(model => model.id), ["auto", "available"], "restart reads the filtered saved list");
      const restarted = normalizeSettingsData(JSON.parse(JSON.stringify(persisted))).settings;
      for (const provider of [echo, persisted.apiProviders[0], restarted.apiProviders[0]]) {
        assert.deepEqual(provider.models.map(model => model.discovery?.typicalPoints), ["3.85", "0.78"], "auto and regular points survive discovery, saving and restart without applying multipliers");
        assert.equal(provider.models[1].displayName, "Available ×5", "shared/mobile names retain their existing multiplier");
        assert.equal(xiaoechoTypicalPointsLabel(provider.models[0], "zh"), "约 3.9 点/次");
        assert.equal(xiaoechoTypicalPointsLabel(provider.models[1], "en"), "~0.78 pts/msg");
      }
      assert.equal(notices, 1); assert.equal(writes, 1);
      await service.refresh(); assert.equal(fetches, 1, "a successful settings discovery counts toward 10 minutes");
      filterXiaoechoProviderDraft(staleEditor);
      assert.deepEqual(staleEditor.models.map(model => model.id), ["auto", "available"], "an old editor draft cannot restore retired tiers");
      for (let step = 0; step < 2; step++) {
        const running = settingsForRunningXiaoechoModel(settings, admitted, "deleted");
        assert.ok(running.apiProviders[0].models.some(model => model.id === "deleted"), "admitted tool-loop follow-up retains its original model");
        assert.equal(running.apiProviders[0].models.find(model => model.id === "deleted")?.maxOutputTokens, admitted.models.find(model => model.id === "deleted")?.maxOutputTokens);
        assert.ok(!settings.apiProviders[0].models.some(model => model.id === "deleted"), "the visible/saved list stays filtered");
      }
      const changedConnection = { ...settings, apiProviders: [{ ...echo, baseUrl: "https://changed.invalid" }, other] };
      assert.equal(settingsForRunningXiaoechoModel(changedConnection, admitted, "deleted"), changedConnection, "the in-flight snapshot cannot override a changed connection");
      assert.equal(repairXiaoechoModelSelection(settings, { providerSettingsId: echo.id, modelId: "deleted" }).modelId, "auto");
      assert.equal(getActiveApiProviderModel(settings)?.model.id, "auto");
      const now = Date.now; Date.now = () => now() + XIAOECHO_CATALOG_MAX_AGE_MS + 1;
      try { await service.refresh(); assert.equal(fetches, 2, "an expired successful fetch refreshes"); } finally { Date.now = now; }
    } finally { service.dispose(); }

    const failed = fixture("catalog-failure");
    const original = JSON.stringify(failed.settings); let failures = 0;
    const failedService = new XiaoechoCatalogService({ settings: failed.settings, token: () => "failure-token", persist: async () => { failures++; }, notifyModelRetired: () => { failures++; } }, async () => ({ status: 503, json: async () => ({}) }));
    try {
      await failedService.refresh(true);
      assert.equal(JSON.stringify(failed.settings), original, "network failure cannot clear the old list or change selection"); assert.equal(failures, 0);
      failed.settings.activeApiProviderId = failed.other.id; failed.settings.defaultModel = failed.other.models[0].id;
      publishXiaoechoModelSignal({ kind: "retired", requestedModelId: "deleted", baseUrl: failed.echo.baseUrl, requestId: "legacy-request" });
      await until(() => failures > 0);
      assert.equal(failed.settings.activeApiProviderId, failed.other.id); assert.equal(failed.settings.defaultModel, failed.other.models[0].id);
      assert.equal(failed.echo.defaultModelId, "auto", "legacy rejection fixes the next turn without a successful catalog GET");
      assert.ok(failed.echo.models.some(model => model.id === "available"), "unrelated cached models survive an unavailable GET");
      assert.ok(!failed.echo.models.some(model => model.id === "deleted"));
      assert.equal(failures, 1, "legacy failure text owns notification; no second success Notice");
    } finally { failedService.dispose(); }

    const signedOut = fixture("catalog-signout"); let token: string | null = "old-account"; let resolve!: () => void;
    const wait = new Promise<void>(done => { resolve = done; });
    const signedOutService = new XiaoechoCatalogService({ settings: signedOut.settings, token: () => token, persist: async () => assert.fail("stale account cannot persist"), notifyModelRetired: () => assert.fail("stale account cannot notify") }, async () => { await wait; return { status: 200, json: async () => catalog() }; });
    try {
      const before = JSON.stringify(signedOut.settings), flight = signedOutService.refresh(true); token = null; resolve(); await flight;
      assert.equal(JSON.stringify(signedOut.settings), before);
    } finally { signedOutService.dispose(); }

    const concurrent = fixture("catalog-activation");
    let disk = structuredClone(concurrent.settings);
    const activationService = new XiaoechoCatalogService({ settings: concurrent.settings, token: () => "activation-token", persist: async () => { disk = structuredClone(concurrent.settings); }, notifyModelRetired: () => {} }, async () => ({ status: 200, json: async () => catalog() }));
    const activationHost = {
      settings: concurrent.settings, piRunConversations: new Map(), productActivity: new ProductActivityGate(), apiProviderActivation: new ApiProviderActivationService(),
      piRuntimeBundle: null, piRuntimeFlight: null,
      cancelAllPiConversationActivations: async () => { await activationService.refresh(true); },
      getSettingsStore: () => ({ readPersistedApiProviderSettingsSnapshot: async () => snapshotApiProviderSettings(disk), restorePersistedApiProviderSettingsSnapshot: async () => {} }),
      saveSettings: async () => { disk = structuredClone(concurrent.settings); }, applyComposerDefaultsToView: () => {}
    };
    try {
      await CodexForObsidianPlugin.prototype.activateApiProviderSettings.call(activationHost as never, candidate => {
        candidate.activeApiProviderId = concurrent.other.id; candidate.defaultModel = concurrent.other.models[0].id;
      }, "preserve");
      assert.deepEqual(disk.apiProviders[0].models.map(model => model.id), ["auto", "available"], "activation's earlier snapshot cannot resurrect a model after an awaited catalog refresh");
      assert.equal(disk.activeApiProviderId, concurrent.other.id);
    } finally { activationService.dispose(); }

    const queued = fixture("catalog-fallback-notice"); let fallbackNotices = 0;
    queued.echo.defaultModelId = "auto"; queued.settings.activeApiProviderId = queued.other.id; queued.settings.defaultModel = queued.other.models[0].id;
    queued.settings.taskWorkspace.newTaskDrafts = {};
    const fallbackService = new XiaoechoCatalogService({ settings: queued.settings, token: () => "fallback-token", persist: async () => {}, notifyModelRetired: () => { fallbackNotices++; } }, async () => ({ status: 503, json: async () => ({}) }));
    try {
      for (const requestId of ["tool-round-1", "tool-round-2"]) publishXiaoechoModelSignal({ kind: "fallback", requestedModelId: "deleted", baseUrl: queued.echo.baseUrl, requestId });
      assert.equal(fallbackNotices, 1, "a queued old-model response still notifies once when current selections are already valid");
      assert.equal(queued.settings.activeApiProviderId, queued.other.id); assert.equal(queued.settings.defaultModel, queued.other.models[0].id);
    } finally { fallbackService.dispose(); }
    console.log("PASS xiaoecho catalog: typical points validation/formatting, desktop names, shared fetch/TTL, persistence/restart, hidden retired tiers, stale editor, future selections, in-flight parameters, failures and account isolation");
  } finally { if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window; }
}
