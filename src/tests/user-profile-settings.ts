import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { App, openTestModals, Platform } from "./obsidian-shim";
import { installProviderBrowserHost } from "./provider-discovery-dom-host";
import { PersonalMemoryRepository } from "../harness/memory/personal-memory-repository";
import { UserProfileSettingsController, type ProfileSnapshot } from "../settings/user-profile-settings";
import { MemoryCorrectionModal } from "../ui/modals";

async function until(condition: () => boolean) { for (let i = 0; i < 400; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail("UI did not settle"); }
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
function field<T extends HTMLElement>(root: HTMLElement, key: string): T { const result = root.querySelector<T>(`[data-profile-focus="${key}"]`); assert(result, key); return result; }
function input(root: HTMLElement, key: string, text: string) { const value = field<HTMLTextAreaElement>(root, `${key}:input`); value.value = text; value.dispatchEvent(new Event("input", { bubbles: true })); }
function click(root: HTMLElement, key: string) { field<HTMLButtonElement>(root, key).click(); }
function textButton(root: HTMLElement, text: string): HTMLButtonElement { const result = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === text); assert(result, text); return result; }

export async function runUserProfileSettingsTests(root: string): Promise<void> {
  installProviderBrowserHost();
  const priorDesktop = Platform.isDesktopApp; Platform.isDesktopApp = true;
  try {
    await profileUi(path.join(root, "repository"));
    await correctionInline();
    await correctionSettingsPages();
  } finally { Platform.isDesktopApp = priorDesktop; }
  console.log("P13 real profile controller/repository and inline/settings-page correction UI: PASS");
}

async function correctionSettingsPages() {
  const container = document.body.createDiv({ cls: "echoink-settings-aligned" });
  let failGeneration = true, failSave = true, conflict = false, saved = 0, navigations = 0;
  const results: string[] = [];
  const modal = new MemoryCorrectionModal(new App() as never, { memoryType: "事实", title: "原标题", content: "原正文", recallWhen: "原时机" }, "zh-CN", {
    generate: async () => { if (failGeneration) throw new Error("fixture generation failure"); return { title: "新标题", content: "新正文", recallWhen: "新时机" }; },
    save: async () => { if (conflict) throw Object.assign(new Error("revision_conflict"), { code: "revision_conflict" }); if (failSave) throw new Error("fixture save failure"); saved++; }
  }, result => results.push(result));
  const mount = (unavailable?: string) => modal.mountSettingsPage(container, { backLabel: "事实", unavailable, onNavigate: () => { navigations++; mount(); } });
  try {
    mount();
    assert.equal(openTestModals.length, 0);
    assert.equal(container.querySelector("h2")?.textContent, "修正记忆");
    assert.equal(container.querySelectorAll(".echoink-memory-correction-current .echoink-memory-correction-field").length, 3);
    const type = (value: string) => { const input = container.querySelector<HTMLTextAreaElement>("textarea")!; input.value = value; input.dispatchEvent(new Event("input")); };
    type("保留完整修正输入");
    textButton(container, "生成预览").click(); await until(() => !modal.submitting);
    assert.equal(container.querySelector("h2")?.textContent, "修正记忆");
    assert.match(container.textContent!, /生成失败/);
    assert.equal(container.querySelector<HTMLTextAreaElement>("textarea")!.value, "保留完整修正输入");
    failGeneration = false;
    textButton(container, "生成预览").click(); await until(() => !modal.submitting);
    assert.equal(container.querySelector("h2")?.textContent, "预览修正");
    assert.equal(container.querySelector<HTMLElement>(".echoink-memory-correction-editor")!.hidden, true);
    assert.equal(container.querySelectorAll(".echoink-memory-correction-preview .echoink-memory-correction-field").length, 3);
    assert.equal(container.querySelector(".echoink-memory-correction-instruction .echoink-memory-correction-field-value")?.textContent, "保留完整修正输入");
    textButton(container, "确认保存").click(); await until(() => !modal.submitting);
    assert.match(container.textContent!, /保存失败/); assert.equal(saved, 0); assert(modal.hasDraft);
    textButton(container, "返回修改").click();
    assert.equal(container.querySelector("h2")?.textContent, "修正记忆");
    assert.equal(container.querySelector<HTMLTextAreaElement>("textarea")!.value, "保留完整修正输入");
    textButton(container, "重新生成预览").click(); await until(() => !modal.submitting);
    conflict = true;
    textButton(container, "确认保存").click(); await until(() => !modal.submitting);
    assert(textButton(container, "确认保存").disabled); assert.equal(results.length, 0);
    modal.updateSettingsRecord({ memoryType: "事实", title: "最新标题", content: "外部新正文", recallWhen: "最新时机" });
    modal.suspend(); mount();
    assert.match(container.textContent!, /外部新正文/); assert.match(container.textContent!, /保留完整修正输入/);
    assert.equal(container.querySelector("h2")?.textContent, "预览修正");
    modal.requestLeave(() => {}); textButton(container, "继续编辑").click();
    assert.equal(document.activeElement, textButton(container, "返回修改"), "preview leave cancellation restores a visible control");
    textButton(container, "返回修改").click();
    modal.suspend(); mount("这条记忆已失效，修正文字仍保留。");
    assert(textButton(container, "重新生成预览").disabled);
    assert.equal(container.querySelector<HTMLTextAreaElement>("textarea")!.value, "保留完整修正输入");
    modal.suspend(); mount(); conflict = false; failSave = false;
    textButton(container, "重新生成预览").click(); await until(() => !modal.submitting);
    textButton(container, "确认保存").click(); await until(() => !modal.submitting);
    assert.equal(saved, 1); assert.deepEqual(results, ["saved"]); assert(navigations >= 5);
  } finally { modal.suspend(); container.remove(); }
  const pendingRoot = document.body.createDiv();
  let signal!: AbortSignal, resolve!: (value: { title: string; content: string; recallWhen: string }) => void;
  const pending = new MemoryCorrectionModal(new App() as never, { memoryType: "事实", title: "旧", content: "旧", recallWhen: "旧" }, "zh-CN", {
    generate: async (_text, requestSignal) => { signal = requestSignal; return new Promise(done => { resolve = done; }); }, save: async () => {}
  }, () => {});
  try {
    pending.mountSettingsPage(pendingRoot, { backLabel: "事实", onNavigate: () => {} });
    const input = pendingRoot.querySelector<HTMLTextAreaElement>("textarea")!; input.value = "停止后保留"; input.dispatchEvent(new Event("input"));
    textButton(pendingRoot, "生成预览").click(); textButton(pendingRoot, "停止").click();
    assert(signal.aborted); assert(!pending.submitting);
    resolve({ title: "过期结果", content: "旧", recallWhen: "旧" }); await settle();
    assert.equal(pendingRoot.querySelector("h2")?.textContent, "修正记忆"); assert(!pendingRoot.textContent!.includes("过期结果"));
    assert.equal(pendingRoot.querySelector<HTMLTextAreaElement>("textarea")!.value, "停止后保留");
  } finally { pending.suspend(); pendingRoot.remove(); }
}

async function profileUi(root: string) {
  await mkdir(root, { recursive: true });
  const repository = new PersonalMemoryRepository({ vaultPath: root, vaultId: "profile-ui-fixture", watchExternalChanges: false });
  await repository.initialize();
  let readFails = false, updateFails = false, updates = 0, removed = 0, returned = 0;
  let delay: Promise<void> | undefined;
  let syntheticObservation = false;
  const read = async (): Promise<ProfileSnapshot> => {
    if (readFails) throw new Error("fixture read unavailable");
    const value = await repository.readUserProfileControlSnapshot();
    return !syntheticObservation || value.items.some(item => item.profileKey === "preference.tone") ? value : { ...value, items: [...value.items, { id: "observed-tone", section: "preference", profileKey: "preference.tone", text: "表达直接", basis: "observed_memory", status: "current", sourceMemoryIds: ["fixture-a", "fixture-b"], revision: 1 }] };
  };
  const host = {
    read,
    update: async (value: { profileKey: string; text: string; expectedRevision: number }) => { updates++; await delay; if (updateFails) throw new Error("fixture save unavailable"); return repository.saveUserProfileFromUserControl(value); },
    confirm: async (value: { profileKey: string; expectedRevision: number }) => { const snapshot = await read(); assert.equal(snapshot.revision, value.expectedRevision); return repository.saveUserProfileFromUserControl({ ...value, text: snapshot.items.find(item => item.profileKey === value.profileKey)!.text }); },
    remove: async (value: { profileKey: string; expectedRevision: number }) => { removed++; return repository.deleteUserProfileFromUserControl(value); },
    back: () => { returned++; }
  };
  const controller = new UserProfileSettingsController(host);
  let container = document.body.createDiv();
  try {
    readFails = true; controller.render(container);
    await until(() => container.textContent!.includes("画像暂时读不到"));
    assert.equal(container.querySelectorAll(".echoink-profile-count").length, 0, "read failure must not pretend the profile is empty");
    readFails = false; textButton(container, "重试").click();
    await until(() => container.querySelectorAll(".echoink-profile-row").length === 24);
    assert.deepEqual(Array.from(container.querySelectorAll(".echoink-profile-count")).map(node => node.textContent), ["0/6", "0/12", "0/6"]);
    assert.equal(container.querySelectorAll("textarea").length, 0);
    click(container, "identity.name:edit");
    input(container, "identity.name", "  "); click(container, "identity.name:save");
    assert.equal(updates, 0); assert.equal(removed, 0); assert(container.textContent!.includes("删除请使用删除操作"));
    input(container, "identity.name", "方哥");
    updateFails = true; click(container, "identity.name:save");
    await until(() => !controller.submitting);
    assert.equal(field<HTMLTextAreaElement>(container, "identity.name:input").value, "方哥");
    assert(controller.hasDraft);
    controller.suspend(); container.remove(); container = document.body.createDiv(); controller.render(container);
    assert.equal(field<HTMLTextAreaElement>(container, "identity.name:input").value, "方哥", "native detach/remount retains drafts");
    click(container, "back"); assert.equal(returned, 0);
    textButton(container, "继续编辑").click(); assert(controller.hasDraft);
    updateFails = false;
    let release!: () => void; delay = new Promise(done => { release = done; });
    click(container, "identity.name:save"); assert(controller.submitting);
    const attempts = updates; click(container, "identity.name:save"); assert.equal(updates, attempts);
    controller.requestLeave(); assert.equal(returned, 0);
    release(); delay = undefined;
    await until(() => !controller.submitting);
    assert.equal((await repository.readUserProfileControlSnapshot()).items[0].text, "方哥");
    assert.equal(container.querySelector(".echoink-profile-count")!.textContent, "1/6");
    click(container, "identity.name:edit"); input(container, "identity.name", "我的草稿");
    const beforeExternal = await repository.readUserProfileControlSnapshot();
    await repository.saveUserProfileFromUserControl({ profileKey: "identity.name", text: "外部新值", expectedRevision: beforeExternal.revision });
    click(container, "identity.name:save"); await until(() => !controller.submitting);
    assert.equal(field<HTMLTextAreaElement>(container, "identity.name:input").value, "我的草稿");
    assert(field<HTMLButtonElement>(container, "identity.name:save").disabled);
    const attemptsAfterConflict = updates; await settle(); assert.equal(updates, attemptsAfterConflict, "conflicts never retry writes automatically");
    assert(container.textContent!.includes("外部新值"));
    click(container, "identity.name:review");
    readFails = true; click(container, "identity.name:save"); await until(() => !controller.submitting);
    assert(container.textContent!.includes("已保存，画像暂时读不到")); assert(!controller.hasDraft);
    assert.equal((await repository.readUserProfileControlSnapshot()).items[0].text, "我的草稿");
    readFails = false; textButton(container, "重试").click(); await until(() => !container.textContent!.includes("画像暂时读不到"));
    assert(field(container, "identity.name:remove").classList.contains("echoink-delete-button"));
    assert(field(container, "identity.name:remove").classList.contains("is-delete-icon"));
    click(container, "identity.name:remove"); assert.equal(removed, 0);
    assert(container.textContent!.includes("只删除这项画像，原记忆会保留"));
    assert(textButton(container, "删除").classList.contains("echoink-delete-button"));
    assert(!textButton(container, "取消").classList.contains("echoink-delete-button"));
    textButton(container, "删除").click(); await until(() => !controller.submitting);
    assert.equal(removed, 1); assert.equal((await repository.readUserControlState()).records.length > 0, true);
    assert.equal((await repository.readUserProfileControlSnapshot()).items.length, 0);
    const reopenedRevision = (await repository.readUserProfileControlSnapshot()).revision;
    await repository.saveUserProfileFromUserControl({ profileKey: "identity.name", text: "重新进入读取的新值", expectedRevision: reopenedRevision });
    controller.refreshWhenOpened(); controller.render(container);
    await until(() => container.textContent!.includes("重新进入读取的新值"));
    click(container, "identity.name:edit"); input(container, "identity.name", "关闭时保留的草稿");
    const composing = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true });
    field<HTMLTextAreaElement>(container, "identity.name:input").dispatchEvent(composing);
    assert.equal(container.querySelector(".echoink-settings-inline-confirm"), null, "IME Escape does not leave an editor");
    controller.render(container);
    assert.equal(field<HTMLTextAreaElement>(container, "identity.name:input").value, "关闭时保留的草稿", "ordinary redraw keeps the input");
    controller.requestLeave(() => { returned++; });
    textButton(container, "放弃修改").click(); await settle(); assert.equal(returned, 1); assert(!controller.hasDraft);
    syntheticObservation = true; controller.suspend();
    const observed = new UserProfileSettingsController(host); observed.render(container);
    await until(() => container.textContent!.includes("系统观察 · 仅供参考"));
    assert(!container.textContent!.includes("fixture-a"));
    click(container, "preference.tone:confirm"); await until(() => !observed.submitting);
    assert.equal((await repository.readUserProfileControlSnapshot()).items.find(item => item.profileKey === "preference.tone")!.basis, "explicit_memory");
    assert(container.textContent!.includes("你确认的")); observed.dispose();
  } finally { controller.dispose(); container.remove(); await repository.dispose(); }
}

async function correctionInline() {
  const container = document.body.createDiv();
  let generated = 0, saved = 0, hasProvider = true, conflict = true, conflicts = 0;
  const results: string[] = [];
  const modal = new MemoryCorrectionModal(new App() as never, { memoryType: "事实", title: "原标题", content: "原正文", recallWhen: "原时机" }, "zh-CN", {
    generate: async () => { if (!hasProvider) throw new Error("no model"); generated++; return { title: "新标题", content: "新正文", recallWhen: "新时机" }; },
    save: async () => { if (conflict) throw Object.assign(new Error("revision_conflict"), { code: "revision_conflict" }); saved++; }
  }, result => results.push(result));
  try {
    modal.mountInline(container, { onConflict: () => { conflicts++; } });
    assert.equal(openTestModals.length, 0, "inline correction never opens an Obsidian Modal");
    assert.equal(container.querySelector("h2"), null, "inline editor does not repeat the outer heading");
    assert.equal(container.querySelector(".echoink-memory-correction-intro"), null);
    assert.equal(container.querySelector(".echoink-memory-correction-current"), null, "inline editor must not show a stale original-memory snapshot");
    let textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "更正实际内容"; textarea.dispatchEvent(new Event("input"));
    textButton(container, "生成预览").click(); await until(() => !modal.submitting);
    assert.equal(generated, 1); assert(modal.hasDraft);
    textButton(container, "确认保存").click(); await until(() => !modal.submitting);
    assert.equal(conflicts, 1); assert.equal(results.length, 0, "inline conflict keeps the same editor alive");
    assert(textButton(container, "确认保存").disabled);
    modal.suspend(); assert(modal.hasDraft); modal.mountInline(container);
    textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    assert.equal(textarea.value, "更正实际内容"); assert(textButton(container, "确认保存").disabled);
    textButton(container, "重新生成预览").click(); await until(() => !modal.submitting);
    conflict = false; hasProvider = false;
    textButton(container, "确认保存").click(); await until(() => !modal.submitting);
    assert.equal(saved, 1, "an existing preview saves locally even after the model is removed");
    assert.deepEqual(results, ["saved"]); assert(!modal.hasDraft);
    const legacy = new MemoryCorrectionModal(new App() as never, { memoryType: "事实", title: "旧", content: "旧", recallWhen: "旧" }, "zh-CN", { generate: async () => { throw new Error("unused"); }, save: async () => {} }, () => {});
    legacy.open(); assert.equal(openTestModals.length, 1);
    assert(legacy.contentEl.querySelector("h2"));
    assert(legacy.contentEl.querySelector(".echoink-memory-correction-intro"));
    assert(legacy.contentEl.querySelector(".echoink-memory-correction-current"), "sidebar Modal keeps the original memory");
    legacy.close(); assert.equal(openTestModals.length, 0, "sidebar Modal path is preserved");
    let ready!: (value: { title: string; content: string; recallWhen: string }) => void;
    let departed = 0;
    const pending = new MemoryCorrectionModal(new App() as never, { memoryType: "事实", title: "旧", content: "旧", recallWhen: "旧" }, "zh-CN", { generate: async () => new Promise(done => { ready = done; }), save: async () => {} }, () => {});
    modal.suspend(); pending.mountInline(container);
    const pendingInput = container.querySelector<HTMLTextAreaElement>("textarea")!;
    pendingInput.value = "生成中的草稿"; pendingInput.dispatchEvent(new Event("input"));
    textButton(container, "生成预览").click(); assert(pending.submitting);
    pending.requestLeave(() => { departed++; }); assert.equal(departed, 0);
    pending.suspend(); pending.mountInline(container);
    assert(container.textContent!.includes("正在生成修正后预览"));
    assert.equal(container.querySelector<HTMLTextAreaElement>("textarea")!.value, "生成中的草稿");
    ready({ title: "重挂预览", content: "新", recallWhen: "新" }); await until(() => !pending.submitting);
    assert(container.textContent!.includes("重挂预览"));
    pending.suspend(); pending.requestLeave(() => { departed++; });
    assert.equal(departed, 0, "detached exit request keeps the draft");
    pending.mountInline(container);
    assert(container.querySelector(".echoink-settings-inline-confirm"), "detached exit request resumes on remount");
    textButton(container, "继续编辑").click(); assert(pending.hasDraft);
    pending.requestLeave(() => { departed++; }); textButton(container, "放弃修改").click(); await settle(); assert.equal(departed, 1); assert(!pending.hasDraft);
    pending.suspend();
  } finally { modal.suspend(); container.remove(); }
}
