import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { PersonalMemoryRepository } from "../harness/memory/personal-memory-repository";
import type { PersonalMemoryRuntimeContext } from "../harness/memory/personal-memory-contracts";
import { MEMORY_ACTIVITY_PATH } from "../harness/memory/memory-activity-store";
import { createSecondaryRecord, serializeSecondaryRecord } from "../harness/memory/secondary-memory-store";
import { queryMemoryPage, memorySourceView, createMemoryPagePort } from "../plugin/memory-page-service";
import { renderMemoryPanel, type MemoryPanelActions, type MemoryPanelState } from "../home/memory/memory-panel";
import type { MemoryPageSnapshot, MemorySource } from "../home/memory/memory-page-types";
import { disposeOriginControls } from "../settings/origin-controls";
import { installObsidianDom } from "./obsidian-dom";
import { CodexMessageListRenderer } from "../ui/codex-view/message-list";
import { runMemoryMapTests } from "./memory-map";
import { normalizeInjectedMemorySources } from "../harness/pi-native/pi-memory-sources";

const conversations = [{ conversationId: "desktop-conversation", status: "active", title: "工作安排" },
  { conversationId: "archived-conversation", status: "archived", title: "旧对话" }];

async function optionalFile(file: string): Promise<string | null> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function assertSources(): void {
  assert.deepEqual(normalizeInjectedMemorySources([{ id: "pin", title: "固定记忆", reason: "pinned" }, { id: "hit", title: "命中记忆", revision: 2, reason: "title_or_trigger" }]),
    [{ id: "pin", title: "固定记忆", reason: "pinned" }, { id: "hit", title: "命中记忆", revision: 2, reason: "title_or_trigger" }], "persisted receipts retain their original reasons");
  const date = "2026-11-03";
  assert.equal(memorySourceView("ui://edit", conversations, date, "en").text, "Edited by you");
  assert.equal(memorySourceView("mobile:entry", conversations, date, "en").text, "Mobile conversation");
  assert.match(memorySourceView("pi://vault/archived-conversation/session/entry", conversations, date, "en").text, /archived/u);
  assert.match(memorySourceView("pi://vault/missing/session/entry", conversations, date, "en").text, /deleted or unavailable/u);
  const active = memorySourceView("pi://vault/desktop-conversation/session/entry%20one?productRun=run", conversations, date);
  assert.deepEqual(active, { text: "工作安排", conversationId: "desktop-conversation", entryId: "entry one" });
  const textOnly = [
    memorySourceView("pi://vault/archived-conversation/session/entry", conversations, date),
    memorySourceView("pi://vault/deleted-conversation/session/entry", conversations, date),
    memorySourceView("pi://vault/desktop-conversation/session", conversations, date),
    memorySourceView("ui://personal-memory-correction", conversations, date),
    memorySourceView("user-edit:entry", conversations, date),
    memorySourceView("user-control:entry", conversations, date),
    memorySourceView("mobile:conversation/entry", conversations, date)
  ];
  assert.deepEqual(memorySourceView("pi://vault/mobile-task/mobile-run/tool-call?productRun=mobile-run", conversations, date), { text: "手机端对话" });
  assert.match(textOnly[0].text, /已归档/u);
  assert.match(textOnly[1].text, /已删除或不可定位/u);
  assert.equal(textOnly[3].text, "你手动修改");
  assert.equal(textOnly[6].text, "手机端对话");
  for (const source of textOnly) {
    assert.equal(source.conversationId, undefined);
    assert.equal(source.entryId, undefined, "unavailable and non-desktop sources cannot expose a jump target");
  }
}

async function assertPageErrorsFollowLanguage(): Promise<void> {
  const settings = { settingsLanguage: "en" };
  const plugin = {
    settings,
    getEchoInkPersonalMemoryState: async () => ({ records: [] })
  };
  const port = createMemoryPagePort(plugin as never, async () => ({
    catalog: { get: async () => ({ status: "archived" }) }
  }) as never, () => undefined);
  await assert.rejects(port.correct("missing", "Title", "Body", 1), /This memory no longer exists/u);
  await assert.rejects(port.source({ text: "Source", conversationId: "old", entryId: "entry" }), /archived or deleted/u);
  settings.settingsLanguage = "zh-CN";
  await assert.rejects(port.correct("missing", "标题", "正文", 1), /这条记忆已不存在/u);
  const repository = {
    readUserControlState: async () => ({ revision: 1 }),
    readUserProfileControlSnapshot: async () => ({ revision: 2 }),
    readSecondaryForUserControl: async () => [],
    previewMemoryActivity: async () => ({})
  };
  await assert.rejects(queryMemoryPage({ repository: repository as never, conversations: [], enabled: true, tokenBudget: 1200, language: "en", request: {} }), /Memories just changed/u);
}

async function repositoryScenarios(root: string): Promise<{ snapshot: MemoryPageSnapshot; plainId: string; richId: string; correctedId: string; profileId: string }> {
  assert.ok(path.isAbsolute(root));
  const base = await realpath(root);
  const vaultPath = await mkdtemp(path.join(base, "repository-"));
  let clock = 1_800_000_000_000, sequence = 0;
  const repository = new PersonalMemoryRepository({ vaultPath, vaultId: "memory-page-fixture", now: () => ++clock,
    idFactory: () => `mem_page_${++sequence}`, watchExternalChanges: false });
  const runtime: PersonalMemoryRuntimeContext = { vaultId: "memory-page-fixture", conversationId: "desktop-conversation",
    piSessionId: "desktop-session", productRunId: "desktop-run", userEntryId: "desktop-entry", memoryMode: "normal", explicitlyAuthorized: true };
  const query = (request = {}): Promise<MemoryPageSnapshot> => queryMemoryPage({ repository, conversations, enabled: true, tokenBudget: 2000,
    request: { now: clock + 10, ...request } });
  try {
    await repository.initialize();
    const pinned = (await repository.write({ operation: "create", kind: "fact", title: "用药安全", content: "对青霉素过敏。",
      recallWhen: "核对用药安全时", basis: "explicit", pinned: true }, runtime)).record!;
    const plain = (await repository.write({ operation: "create", kind: "view", title: "阅读习惯", content: "先读纸质书，再做笔记。",
      recallWhen: "安排阅读时", basis: "explicit" }, { ...runtime, userEntryId: "reading-entry" })).record!;
    const rich = (await repository.write({ operation: "create", kind: "view", title: "项目复盘", content: "每周下午检查交付安排。",
      recallWhen: "安排工作回顾时", scope: "project:北斗", due: "2027-02-01", basis: "inferred", reason: "根据项目安排推断" }, { ...runtime, userEntryId: "project-entry" })).record!;
    const secondary = createSecondaryRecord({ parentId: rich.id, title: "午后饮品场景", content: "此场景关联项目复盘的安排。",
      recallWhen: "讨论下午饮品时", matchTerms: ["茉莉冷萃"], relation: "context", reason: "从场景找回已有安排", supportLevel: "direct",
      evidence: "父记忆明确规定下午检查安排。", basis: "llm_inferred", confidence: 0.7, sourceMemoryRevision: rich.revision,
      now: ++clock, idFactory: () => "sec_page_project" });
    await repository.applyCognitiveUpdate({ secondaryRecords: [secondary], extraChanges: [{ relativePath: secondary.file, content: serializeSecondaryRecord(secondary) }], detail: "memory-page-fixture" });
    const activityPath = path.join(repository.layout.root, MEMORY_ACTIVITY_PATH);
    const secondaryPath = path.join(repository.layout.root, secondary.file);
    const beforeSecondary = await readFile(secondaryPath, "utf8");
    assert.equal(await optionalFile(activityPath), null);
    const initial = await query();
    assert.equal(initial.stars.length, 3);
    assert.ok(initial.stars.every(star => star.recallCount === 0));
    const preview = await query({ query: "茉莉冷萃" });
    assert.ok(preview.preview?.recalled.includes(rich.id), "preview must exercise a real secondary-only match");
    assert.ok(preview.preview?.recalled.includes(pinned.id), "fixed core memories remain part of the real preview");
    assert.equal(await optionalFile(activityPath), null, "map and search preview cannot initialize activity storage");
    assert.deepEqual(await repository.readSecondaryForUserControl(), [secondary]);
    assert.equal(await readFile(secondaryPath, "utf8"), beforeSecondary, "preview cannot persist secondary hit statistics");
    assert.equal(preview.revision, initial.revision);

    assert.equal(await repository.recordRecalledMemories([rich.id], "successful-real-turn"), true);
    await repository.recordSecondaryRecallHits([{ secondaryId: secondary.id, parentId: rich.id }]);
    const beforeActivity = await readFile(activityPath, "utf8");
    const hitSecondary = await repository.readSecondaryForUserControl();
    const hitBytes = await readFile(secondaryPath, "utf8");
    assert.equal(hitSecondary[0].hitCount, 1, "positive control proves the fixture persists real hit statistics");
    const afterHit = await query({ query: "茉莉冷萃" });
    await query(); await query({ query: "用药安全" });
    assert.equal(afterHit.stars.find(star => star.id === rich.id)?.recallCount, 1);
    assert.equal(await readFile(activityPath, "utf8"), beforeActivity);
    assert.deepEqual(await repository.readSecondaryForUserControl(), hitSecondary);
    assert.equal(await readFile(secondaryPath, "utf8"), hitBytes);
    const receipt = { conversationId: "a-prior-turn", messageId: "message-1", sources: [
      { id: "no-longer-current", title: "当轮实际标题", reason: "title_or_trigger" },
      { id: pinned.id, title: "当时的用药标题", reason: "pinned" }
    ] };
    const receiptPage = await query({ receipt });
    assert.deepEqual(receiptPage.receipt, receipt, "historical receipts preserve their own ids, order, titles and reasons");
    assert.equal(receiptPage.preview, undefined, "receipt browsing cannot rerun recall");

    const first = (await repository.supersedeFromUserCorrection({ targetId: pinned.id, title: "用药禁忌", content: "已确认对青霉素过敏。",
      recallWhen: pinned.recallWhen, reason: "你手动修正了这条记忆", expectedRevision: receiptPage.revision })).record!;
    const second = (await repository.supersedeFromUserCorrection({ targetId: first.id, title: "用药限制", content: "就医时提醒青霉素过敏。",
      recallWhen: first.recallWhen, reason: "补充就医场景", expectedRevision: (await query()).revision })).record!;
    const correctedPage = await query();
    const corrected = correctedPage.stars.find(star => star.id === second.id)!;
    assert.equal(corrected.pinned, true);
    assert.equal(corrected.layer, "core");
    assert.equal(corrected.recallWhen, pinned.recallWhen);
    assert.deepEqual(corrected.history.map(record => [record.id, record.reason]), [[first.id, "补充就医场景"], [pinned.id, "你手动修正了这条记忆"]]);
    assert.ok(!correctedPage.stars.some(star => star.id === pinned.id || star.id === first.id));

    await repository.saveUserProfileFromUserControl({ profileKey: "preference.format", text: "先看结论，再看依据", expectedRevision: correctedPage.revision });
    let profilePage = await query();
    const profile = profilePage.profile.find(item => item.profileKey === "preference.format")!;
    assert.equal(profile.text, "先看结论，再看依据");
    const profileId = profile.sourceMemoryIds.find(id => profilePage.stars.some(star => star.id === id))!;
    assert.ok(profileId);
    assert.ok(profilePage.stars.find(star => star.id === profileId)?.profiles.some(item => item.profileKey === profile.profileKey));
    await repository.saveUserProfileFromUserControl({ profileKey: profile.profileKey, text: "结论放在第一句", expectedRevision: profilePage.revision });
    profilePage = await query();
    assert.equal(profilePage.profile.find(item => item.profileKey === profile.profileKey)?.text, "结论放在第一句");
    const finalProfileId = profilePage.profile.find(item => item.profileKey === profile.profileKey)!.sourceMemoryIds.find(id => profilePage.stars.some(star => star.id === id))!;
    await repository.deleteUserProfileFromUserControl({ profileKey: profile.profileKey, expectedRevision: profilePage.revision });
    const deleted = await query();
    assert.ok(!deleted.profile.some(item => item.profileKey === profile.profileKey));
    assert.ok(deleted.stars.every(star => !star.profiles.some(item => item.profileKey === profile.profileKey)));
    const disabled = await queryMemoryPage({ repository, conversations, enabled: false, tokenBudget: 2000, request: { query: "茉莉冷萃", now: clock } });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.stars.length, deleted.stars.length, "disabled memory remains browseable");
    assert.deepEqual(disabled.preview?.recalled, []);
    const open = (await repository.write({ operation: "create", kind: "open_loop", title: "会议日程未定", content: "还没有决定会议日期。", recallWhen: "讨论会议日程时", basis: "explicit" }, { ...runtime, userEntryId: "open-entry" })).record!;
    const activityBeforeFadedSearch = await optionalFile(activityPath);
    const futureSearch = await query({ query: "会议日程", now: clock + 400 * 86_400_000 });
    assert.ok(futureSearch.preview?.faded.includes(open.id), "a faded open question is still found by the shared explicit-search scorer");
    assert.ok(!futureSearch.preview?.recalled.includes(open.id), "the same faded open question stays out of automatic recall");
    assert.equal(await optionalFile(activityPath), activityBeforeFadedSearch);
    return { snapshot: profilePage, plainId: plain.id, richId: rich.id, correctedId: second.id, profileId: finalProfileId };
  } finally {
    await repository.dispose();
    await rm(vaultPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function preparePanelDocument(win: Window & typeof globalThis): void {
  installObsidianDom(win);
  Object.assign(win.Element.prototype, {
    empty(this: Element) { this.replaceChildren(); },
    addClass(this: Element, ...names: string[]) { this.classList.add(...names); },
    removeClass(this: Element, ...names: string[]) { this.classList.remove(...names); },
    toggleClass(this: Element, name: string, force: boolean) { this.classList.toggle(name, force); },
    createEl<K extends keyof HTMLElementTagNameMap>(this: Element, tag: K, options?: DomElementInfo | string) { const element = win.createEl(tag, options); this.append(element); return element; },
    createDiv(this: Element, options?: DomElementInfo | string) { const element = win.createDiv(options); this.append(element); return element; },
    createSpan(this: Element, options?: DomElementInfo | string) { const element = win.createSpan(options); this.append(element); return element; }
  });
}

function panelScenarios(win: Window & typeof globalThis, data: Awaited<ReturnType<typeof repositoryScenarios>>): void {
  preparePanelDocument(win);
  const host = win.document.createElement("div"); win.document.body.append(host);
  const calls: string[] = [], sources: MemorySource[] = [];
  const drafts: Partial<Record<"title" | "content" | "profileText", string>> = {};
  let savedDraft: typeof drafts | undefined;
  const actions: MemoryPanelActions = {
    overview: () => calls.push("overview"), select: id => calls.push(`select:${id}`), layer: id => calls.push(`layer:${id}`),
    profile: key => calls.push(`profile:${key ?? ""}`), edit: () => calls.push("edit"), cancelEdit: () => calls.push("cancelEdit"),
    draft: (field, value) => { drafts[field] = value; }, save: () => { savedDraft = { ...drafts }; },
    pin: () => calls.push("pin"), restore: () => calls.push("restore"), confirmForget: value => calls.push(`confirm:${value}`),
    forget: () => calls.push("forget"), saveProfile: () => calls.push("saveProfile"), deleteProfile: () => calls.push("deleteProfile"), confirmProfileDelete: value => calls.push(`profileDelete:${value}`),
    source: source => sources.push(source)
  };
  const draw = (state: MemoryPanelState, snapshot = data.snapshot, busy = false) => renderMemoryPanel(host, snapshot, state, actions, busy, "zh-CN");
  const click = (text: string) => { const button = Array.from(host.querySelectorAll("button")).find(element => element.textContent?.trim() === text); assert.ok(button, `button ${text} exists`); button.click(); };
  const sections = () => Array.from(host.querySelectorAll(".memory-section-heading")).map(element => element.textContent);
  try {
    draw({ mode: "detail", id: data.plainId });
    assert.deepEqual(sections(), ["来源"], "absent optional data cannot create placeholder groups");
    assert.equal(host.querySelectorAll(".memory-field").length, 3);
    click("修正"); assert.equal(calls.at(-1), "edit");
    host.querySelector<HTMLButtonElement>(".memory-source-link")!.click();
    assert.equal(sources[0].conversationId, "desktop-conversation");
    draw({ mode: "detail", id: data.plainId, editing: true });
    const title = host.querySelector<HTMLInputElement>(".memory-edit-title")!;
    const content = host.querySelector<HTMLTextAreaElement>(".memory-editor")!;
    title.value = "修正后的标题"; title.dispatchEvent(new win.Event("input", { bubbles: true }));
    content.value = "修正后的正文"; content.dispatchEvent(new win.Event("input", { bubbles: true }));
    click("保存");
    assert.deepEqual(savedDraft, { title: "修正后的标题", content: "修正后的正文" }, "save receives the actual input drafts");
    assert.ok(host.querySelector(".memory-source-link"), "editing preserves source visibility");
    draw({ mode: "detail", id: data.richId });
    assert.ok(sections().includes("依据") && sections().includes("联想"));
    assert.match(host.textContent!, /所属项目北斗/u); assert.match(host.textContent!, /到期2027-02-01/u);
    assert.match(host.textContent!, /根据项目安排推断/u);
    draw({ mode: "detail", id: data.correctedId });
    assert.ok(sections().includes("之前"));
    assert.match(host.textContent!, /补充就医场景/u);
    assert.equal(host.querySelector(".memory-source-link"), null, "manually corrected records remain text-only sources");
    draw({ mode: "detail", id: data.profileId });
    assert.ok(sections().includes("支撑画像"));
    click("结论放在第一句"); assert.equal(calls.at(-1), "profile:preference.format");
    draw({ mode: "profile" });
    const row = host.querySelector<HTMLButtonElement>('[data-profile-key="preference.format"]')!;
    assert.equal(row.getAttribute("aria-expanded"), "false"); row.click();
    assert.match(row.textContent!, /手动/u, "an edited profile states that its content is user-controlled");
    draw({ mode: "profile" }, { ...data.snapshot, profile: data.snapshot.profile.map(item => ({ ...item, userEdited: false })) });
    assert.equal(host.querySelector(".memory-profile-count")!.textContent, `${data.snapshot.profile[0].sourceMemoryIds.length} 条`, "observed profiles show the actual supporting-memory count");
    assert.equal(calls.at(-1), "profile:preference.format");
    draw({ mode: "profile", profileKey: "preference.format" });
    assert.equal(host.querySelector('[data-profile-key="preference.format"]')!.getAttribute("aria-expanded"), "true");
    const editor = host.querySelector<HTMLTextAreaElement>("textarea")!;
    editor.value = "画像草稿"; editor.dispatchEvent(new win.Event("input", { bubbles: true }));
    assert.equal(drafts.profileText, "画像草稿"); click("保存"); assert.equal(calls.at(-1), "saveProfile");
    host.querySelector<HTMLButtonElement>('[aria-label="删除这条画像"]')!.click(); assert.equal(calls.at(-1), "profileDelete:true");
    draw({ mode: "profile", profileKey: "preference.format", confirmProfileDelete: true });
    click("删除"); assert.equal(calls.at(-1), "deleteProfile");
    host.querySelector<HTMLButtonElement>('[data-profile-key="preference.format"]')!.click(); assert.equal(calls.at(-1), "profile:");
    draw({ mode: "detail", id: data.plainId, editing: true }, data.snapshot, true);
    assert.ok(Array.from(host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input,textarea,button")).every(element => element.disabled));
    const callsBefore = calls.length; click("取消"); assert.equal(calls.length, callsBefore, "busy controls cannot mutate or navigate");
    draw({ mode: "receipt" }, { ...data.snapshot, receipt: { conversationId: "turn", question: "原问题", sources: [
      { id: data.plainId, title: "记忆一", reason: "title_or_trigger" },
      { id: data.richId, title: "记忆二", reason: "content_or_association" }
    ] } });
    assert.equal(host.querySelector(".memory-panel-back"), null);
    assert.doesNotMatch(host.textContent!, /回到对话|标题或触发场景|content_or_association/u);
    assert.match(host.textContent!, /和这句话直接相关/u);
    assert.match(host.textContent!, /内容有关联/u);
    draw({ mode: "search" }, { ...data.snapshot, preview: { query: "问题", recalled: [data.plainId], faded: [data.richId], reasons: { [data.plainId]: "pinned" } } });
    assert.equal(host.querySelector(".memory-panel-back"), null);
    assert.match(host.querySelector(".memory-list-label")!.textContent!, /每轮必带/u);
    assert.match(host.querySelectorAll(".memory-list")[1].textContent!, /○/u);
    draw({ mode: "detail", id: "missing" }); assert.match(host.textContent!, /已被替换或忘记/u);
  } finally { disposeOriginControls(host); host.remove(); }
}

export async function runMemoryPageTests(root: string, win: Window & typeof globalThis): Promise<void> {
  assertSources();
  await assertPageErrorsFollowLanguage();
  const data = await repositoryScenarios(root);
  panelScenarios(win, data);
  const host = win.document.createElement("div");
  const target = host.createDiv({ attr: { "data-message-id": "revealed" } });
  const child = target.createSpan();
  const renderer = new CodexMessageListRenderer();
  const internal = renderer as unknown as { env: unknown; revealedMessageId: string | null; revealedMessageAt: number; markRevealedMessage(): void };
  internal.env = { virtualListEl: host };
  internal.revealedMessageId = "revealed";
  internal.revealedMessageAt = Date.now();
  internal.markRevealedMessage();
  assert.ok(target.classList.contains("codex-memory-source-target"));
  const startedAt = internal.revealedMessageAt;
  internal.markRevealedMessage();
  assert.equal(internal.revealedMessageAt, startedAt, "ordinary rerenders cannot renew the hint");
  const endHint = target.onanimationend!;
  endHint.call(target, { target: child, animationName: "echoink-memory-source-hint" } as unknown as AnimationEvent);
  assert.ok(target.classList.contains("codex-memory-source-target"), "a child animation cannot dismiss the message hint");
  endHint.call(target, { target, animationName: "echoink-memory-source-hint" } as unknown as AnimationEvent);
  assert.ok(!target.classList.contains("codex-memory-source-target"));
  assert.equal(target.onanimationend, null, "the finished hint releases its event handler");
  assert.equal(internal.revealedMessageId, null);
  internal.revealedMessageId = "revealed";
  internal.revealedMessageAt = Date.now() - 2_001;
  internal.markRevealedMessage();
  assert.ok(!target.classList.contains("codex-memory-source-target"), "late virtual-list rerenders cannot revive an expired hint");
  renderer.dispose();
  runMemoryMapTests();
  console.log("PASS Memory page: real read-only queries/recall previews, immutable receipt, correction history, profile transactions, source boundaries and panel interactions");
}
