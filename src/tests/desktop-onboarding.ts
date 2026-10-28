import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SETTINGS, createApiProviderConfig, normalizeSettingsData, type SetupSettings } from "../settings/settings";
import { loadMobileSettings } from "../mobile/settings";
import { advanceEchoInkOnboardingTutorial, deriveEchoInkOnboardingTruth, dismissEchoInkOnboardingTutorial, ECHOINK_ONBOARDING_STEPS, ECHOINK_ONBOARDING_VERSION, onboardingCoachmarkCopy, onboardingCompletionCopy, prepareEchoInkOnboardingTutorial, selectEchoInkOnboardingStep, shouldAutoStartEchoInkOnboarding } from "../settings/onboarding";

const setup = (value: Record<string, unknown> = {}) => normalizeSettingsData({ setup: value }).settings.setup;

export async function runDesktopOnboardingTests(root: string) {
  migration(); cursor(); copy();
  await savedSettingsRoundTrip(root);
  console.log("P15 onboarding model PASS: old completion/skip, five-step migration, explicit replay, stale controls, copy and desktop/mobile settings round-trip");
}

function migration() {
  assert.notEqual(ECHOINK_ONBOARDING_VERSION, "onboarding-v2");
  assert.deepEqual(ECHOINK_ONBOARDING_STEPS, ["sidebar", "provider", "knowledge", "personality", "colleague"]);
  for (const value of [undefined, null, {}, { setup: {} }, { setup: { tutorialStep: "unrecognized" } }]) {
    const settings = normalizeSettingsData(value).settings;
    assert.equal(settings.setup.tutorialStep, "sidebar");
    assert.equal(shouldAutoStartEchoInkOnboarding(value === undefined, settings.setup, true), true);
    assert.equal(prepareEchoInkOnboardingTutorial(settings.setup, { forceRestart: false }), true);
    assert.equal(settings.setup.tutorialStep, "sidebar");
  }
  for (const version of ["", "onboarding-v1", "onboarding-v2", ECHOINK_ONBOARDING_VERSION, "unknown-version"]) {
    for (const [old, expected] of [["sidebar", "sidebar"], ["settings", "sidebar"], ["provider", "provider"], ["knowledge", "knowledge"], ["personality", "personality"], ["colleague", "colleague"], ["unknown", "sidebar"]] as const) {
      const progress = setup({ tutorialVersion: version, tutorialStep: old, onboardingAgentId: "tutorial-agent", paperGuideDismissedAt: 37 });
      assert.equal(progress.tutorialStep, expected, `load ${old}`);
      assert.equal(shouldAutoStartEchoInkOnboarding(false, progress, true), true);
      const changed = prepareEchoInkOnboardingTutorial(progress, { forceRestart: false });
      assert.equal(changed, version !== ECHOINK_ONBOARDING_VERSION);
      assert.equal(progress.tutorialStep, expected, `resume ${version}/${old}`);
      assert.equal(progress.onboardingAgentId, "tutorial-agent"); assert.equal(progress.paperGuideDismissedAt, 37);
      assert.equal(prepareEchoInkOnboardingTutorial(progress, { forceRestart: false }), false, "migration is idempotent");
    }
    for (const prior of [{ completedAt: 123 }, { dismissedVersion: version || "old-explicit-skip" }, { completedAt: 123, dismissedVersion: "old-explicit-skip" }]) {
      const progress = setup({ tutorialVersion: version, tutorialStep: "knowledge", paperGuideDismissedAt: 55, onboardingAgentId: "already-created", ...prior });
      const before = structuredClone(progress);
      for (const empty of [false, true]) for (const enabledAfterLayoutReady of [false, true]) {
        assert.equal(shouldAutoStartEchoInkOnboarding(empty, progress, enabledAfterLayoutReady), false, "upgrading/enabling cannot override completion or skip");
        assert.equal(prepareEchoInkOnboardingTutorial(progress, { forceRestart: false }), false);
        assert.deepEqual(progress, before, "historical completion, dismissal, paper choice and creation ID survive");
      }
      assert.equal(prepareEchoInkOnboardingTutorial(progress, { forceRestart: true }), true);
      assert.equal(progress.tutorialStep, "sidebar"); assert.equal(progress.completedAt, 0); assert.equal(progress.dismissedVersion, "");
      assert.equal(progress.onboardingAgentId, "already-created", "explicit replay cannot forget the colleague it already created");
      assert.equal(progress.paperGuideDismissedAt, 55);
    }
  }
  const raw = { ...setup(), tutorialVersion: "onboarding-v2", tutorialStep: "settings" as const };
  assert.equal(selectEchoInkOnboardingStep(raw, "settings", "provider"), false, "an old hidden control cannot navigate before migration");
  assert.equal(advanceEchoInkOnboardingTutorial(raw, "settings", 999).changed, false);
  assert.equal(prepareEchoInkOnboardingTutorial(raw, { forceRestart: false }), true); assert.equal(raw.tutorialStep, "sidebar", "legacy cursor also migrates before normalization");
}

function cursor() {
  const progress = setup({ onboardingAgentId: "created-once", paperGuideDismissedAt: 88 });
  prepareEchoInkOnboardingTutorial(progress, { forceRestart: false });
  for (let index = 0; index < ECHOINK_ONBOARDING_STEPS.length; index++) {
    const step = ECHOINK_ONBOARDING_STEPS[index];
    const previous = structuredClone(progress);
    assert.equal(selectEchoInkOnboardingStep(progress, "settings", "provider"), false, "stale legacy entry cannot move new steps");
    assert.deepEqual(progress, previous);
    if (index > 0) {
      const back = ECHOINK_ONBOARDING_STEPS[index - 1];
      assert.equal(selectEchoInkOnboardingStep(progress, step, back), true); assert.equal(progress.completedAt, 0);
      assert.equal(selectEchoInkOnboardingStep(progress, step, "sidebar"), false, "stale progress click is ignored");
      assert.equal(selectEchoInkOnboardingStep(progress, back, step), true);
    }
    assert.equal(selectEchoInkOnboardingStep(progress, step, "settings"), false, "legacy settings is absent from new progress controls");
    const result = advanceEchoInkOnboardingTutorial(progress, step, 100 + index);
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(result, index < 4 ? { changed: true, completed: false, nextStep: ECHOINK_ONBOARDING_STEPS[index + 1] } : { changed: true, completed: true, nextStep: null });
    if (index < 4) { assert.equal(progress.completedAt, 0); const after = structuredClone(progress); assert.equal(advanceEchoInkOnboardingTutorial(progress, step, 999).changed, false); assert.deepEqual(progress, after); }
  }
  assert.equal(progress.completedAt, 104); assert.equal(progress.lastCheckedAt, 104); assert.equal(progress.paperGuideDismissedAt, 0);
  assert.equal(progress.onboardingAgentId, "created-once"); assert.equal(progress.tutorialStep, "sidebar"); assert.equal(shouldAutoStartEchoInkOnboarding(false, progress, true), false);
  const completed = structuredClone(progress); assert.equal(advanceEchoInkOnboardingTutorial(progress, "colleague", 1000).changed, false); assert.deepEqual(progress, completed, "late create completion is ignored");
  for (const step of ECHOINK_ONBOARDING_STEPS) {
    const skip = setup({ tutorialStep: step, onboardingAgentId: "keep-agent", paperGuideDismissedAt: 77 });
    dismissEchoInkOnboardingTutorial(skip);
    assert.equal(skip.tutorialStep, step); assert.equal(skip.completedAt, 0); assert.equal(skip.paperGuideDismissedAt, 77); assert.equal(skip.onboardingAgentId, "keep-agent");
    assert.equal(shouldAutoStartEchoInkOnboarding(false, skip, true), false); assert.equal(prepareEchoInkOnboardingTutorial(skip, { forceRestart: false }), false);
  }
}

function copy() {
  const titles = ["认识工作台和你的 Agent", "连接一个模型", "给知识库安个家", "认识总助", "再请一位同事"];
  for (const [index, step] of ECHOINK_ONBOARDING_STEPS.entries()) {
    const cn = onboardingCoachmarkCopy(step, true), en = onboardingCoachmarkCopy(step, false);
    assert.equal(cn.title, titles[index]); assert.equal(cn.step, `认识 EchoInk · 0${index + 1} / 05`);
    assert.equal(cn.steps.length, 5); assert.equal(cn.steps.some(row => row.key === "settings"), false);
    assert.equal(cn.action, index === 4 ? "创建并完成" : "下一步"); assert.equal(en.action, index === 4 ? "Create and finish" : "Next");
    assert.equal(cn.tone, "purple"); assert.equal(en.tone, "purple", "all steps use the same theme-driven tone hook");
    assert.equal(cn.previousLabel, index ? "上一步" : "稍后再说"); assert.equal(cn.dismissLabel, "跳过引导");
    assert.ok(en.title); assert.ok(en.description); assert.equal(en.steps.length, 5);
  }
  assert.equal(onboardingCoachmarkCopy("settings", true).step, "认识 EchoInk · 01 / 05", "legacy copy never exposes step 00 or a sixth step");
  assert.equal(onboardingCompletionCopy(true).title, "准备好了，从一件事开始"); assert.equal(onboardingCompletionCopy(true).previousLabel, "再看一遍");
}

async function savedSettingsRoundTrip(root: string) {
  const provider = createApiProviderConfig("deepseek", "configured-provider"); provider.apiKey = "synthetic-key";
  const stored = normalizeSettingsData({ ...structuredClone(DEFAULT_SETTINGS), apiProviders: [provider], activeApiProviderId: provider.id, setup: { tutorialVersion: "onboarding-v2", tutorialStep: "personality", onboardingAgentId: "saved-colleague", paperGuideDismissedAt: 91 } }).settings;
  stored.knowledgeBase.initialization.status = "initialized";
  const { setup: originalSetup, ...configuration } = structuredClone(stored);
  assert.equal(deriveEchoInkOnboardingTruth(stored, "existing-personality").providerComplete, true);
  assert.equal(shouldAutoStartEchoInkOnboarding(false, stored.setup), true, "real setup truth does not complete a tutorial");
  assert.equal(prepareEchoInkOnboardingTutorial(stored.setup, { forceRestart: false }), true);
  assert.equal(stored.setup.tutorialStep, "personality"); assert.equal(originalSetup.tutorialStep, "personality");
  const { setup: _setup, ...after } = stored; assert.deepEqual(after, configuration, "migration changes no saved provider, knowledge, or Agent data");
  const file = path.join(root, "synthetic-settings.json"); await writeFile(file, JSON.stringify(stored));
  const loaded = normalizeSettingsData(JSON.parse(await readFile(file, "utf8"))).settings;
  assert.deepEqual(loaded.setup, stored.setup);
  const mobile = loadMobileSettings(JSON.parse(JSON.stringify(loaded)));
  const reloaded = normalizeSettingsData(JSON.parse(JSON.stringify(mobile))).settings;
  assert.deepEqual(reloaded.setup, loaded.setup, "mobile load/save preserves current onboarding fields without executing desktop guide");
  for (const prior of [{ completedAt: 1000, dismissedVersion: "onboarding-v1" }, { completedAt: 0, dismissedVersion: "onboarding-v2" }]) {
    const history: SetupSettings = { ...loaded.setup, ...prior };
    const phone = loadMobileSettings({ ...loaded, setup: history });
    const desktop = normalizeSettingsData(JSON.parse(JSON.stringify(phone))).settings;
    assert.deepEqual(desktop.setup, history); assert.equal(shouldAutoStartEchoInkOnboarding(false, desktop.setup, true), false);
  }
}
