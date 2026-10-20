import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { defaultTaskWorkspace, normalizeTaskWorkspace } from "../agents/task-workspace";
import { checkAgentCapability, checkAgentTool, type AgentCapabilityContext } from "../agents/capability-policy";
import { ENGLISH_DIARY_TASK_CONTEXT, buildEnglishDiaryTaskContext, englishDiaryTaskContextFromEntries, normalizeEnglishDiarySourcePath } from "../english-diary/task-context";
import { resolvePiTurnToolNames } from "../harness/pi-native/pi-native-conversation-runtime";
import { createDurablePiSession, openDurablePiSession, persistPiActiveLeaf } from "../harness/pi-native/pi-session-durability";
import { createPiKnowledgeInlineExtension } from "../plugin/pi-production-runtime-composition";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { unavailableCapabilityAccess } from "../membership/access";
import { DEFAULT_SETTINGS } from "../settings/settings";
import { hasEnglishDiarySourceContent } from "../home/english-diary-source";
import { renderNativeJournalTemplate } from "../home/native-journal";
import { journalTemplateBaseline } from "../home/workbench-journal";
import { CodexView } from "../ui/codex-view";
import { consumeAcceptedTaskDraft, TaskNavigationState } from "../ui/codex-view/task-navigation-state";
import { RuntimeTurnQueue, type QueuedTurnItem } from "../ui/turn-queue";
import { paidTestAccess } from "./membership-access";

const SOURCE = "Daily/2027-01-02.md";
const OTHER_SOURCE = "Daily/2027-01-03.md";
const SECRET = "SYNTHETIC_PRIVATE_MATERIAL_MUST_NOT_REACH_DIARY_TASK";
const PROMPT = "请把今天的日记生成英文，沿用已确认的发送范围";

async function draftScopeLifecycle(root: string): Promise<void> {
  let workspace = defaultTaskWorkspace();
  let navigation = new TaskNavigationState(() => workspace);
  navigation.navigate({ kind: "list", agentId: "sol" });
  assert.equal(navigation.prefill("sol", PROMPT, "english-diary:new", SOURCE), true);
  navigation.navigate({ kind: "list", agentId: "colleague" });
  navigation.save({ text: "另一位的旧草稿", attachments: [] });
  navigation.navigate({ kind: "detail", taskId: "existing-task" });
  navigation.save({ text: "旧任务的回复", attachments: [] });
  navigation.navigate({ kind: "list", agentId: "sol" });
  assert.equal(navigation.draft().englishDiarySourcePath, SOURCE, "avatar/list switches preserve the selected source");
  const workspaceFile = path.join(root, "task-workspace.json");
  await writeFile(workspaceFile, JSON.stringify(workspace));
  workspace = normalizeTaskWorkspace(JSON.parse(await readFile(workspaceFile, "utf8")));
  navigation = new TaskNavigationState(() => workspace);
  assert.equal(navigation.draft().englishDiarySourcePath, SOURCE, "normalization after real save/reload preserves scope");
  assert.equal(navigation.prefill("sol", "覆盖旧稿", "other-origin", OTHER_SOURCE), false);
  assert.equal(navigation.draft().text, PROMPT); assert.equal(navigation.draft().englishDiarySourcePath, SOURCE);
  assert.equal(navigation.prefill("colleague", PROMPT, "english-diary:new", SOURCE), false);
  assert.equal(workspace.newTaskDrafts.colleague.text, "另一位的旧草稿");

  const item: QueuedTurnItem = {
    id: "queued-diary", sessionId: "new-diary-task", text: PROMPT, composerTextSnapshot: PROMPT,
    prefillSource: "english-diary:new", englishDiarySourcePath: SOURCE, attachments: [], skill: null,
    turnOptions: { providerSettingsId: "offline", runtimeProviderId: "offline", model: "offline", reasoning: "none", permission: "workspace-write", mode: "agent", mcpEnabled: false },
    kind: "chat", createdAt: 1
  };
  const queue = new RuntimeTurnQueue();
  const acceptedSnapshot = queue.enqueue(item);
  item.englishDiarySourcePath = OTHER_SOURCE; item.text = "后来修改的请求";
  assert.equal(queue.peekNext(item.sessionId)!.englishDiarySourcePath, SOURCE, "the queued turn freezes the original scope");
  navigation.save({ ...navigation.draft(), englishDiarySourcePath: OTHER_SOURCE });
  assert.equal(consumeAcceptedTaskDraft(workspace, "agent:sol", acceptedSnapshot), false, "late acceptance cannot clear equal text scoped to a different diary");
  navigation.save({ ...navigation.draft(), englishDiarySourcePath: SOURCE });
  navigation.navigate({ kind: "detail", taskId: "existing-task" });
  assert.equal(queue.acceptPiUserEntry(acceptedSnapshot.sessionId, acceptedSnapshot.id), true);
  assert.equal(consumeAcceptedTaskDraft(workspace, "agent:sol", acceptedSnapshot), true);
  assert.equal(queue.hasQueuedItems(acceptedSnapshot.sessionId), false);
  assert.deepEqual(workspace.newTaskDrafts.sol, { text: "", attachments: [] });
  assert.equal(workspace.newTaskDrafts.colleague.text, "另一位的旧草稿");
  assert.equal(workspace.replyDrafts["existing-task"].text, "旧任务的回复");
  console.log("PASS task drafts: prefill, avatar switching, saved reload, existing draft protection, queued snapshot and same-scope acceptance.");

  // Exercise the actual Composer save adapter, including its blank-text scope removal.
  navigation.navigate({ kind: "list", agentId: "sol" });
  assert.equal(navigation.prefill("sol", PROMPT, "english-diary:new", SOURCE), true);
  let saves = 0;
  const host = Object.assign(Object.create(CodexView.prototype), {
    taskUiMounted: true, taskNav: navigation, inputEl: { value: " \n " }, composerDraftOwner: "agent:sol",
    attachments: [], selectedSkill: null, selectedProviderSettingsId: "offline", selectedModel: "offline",
    selectedPermission: "workspace-write", selectedMode: "agent", composerSessionDrafts: new Map(),
    plugin: { settings: { taskWorkspace: workspace }, getConversationRunService: () => ({ scheduleSave: () => { saves++; } }) }
  });
  (CodexView.prototype as any).saveTaskComposerDraft.call(host);
  assert.equal(Object.hasOwn(workspace.newTaskDrafts.sol, "englishDiarySourcePath"), false);
  assert.equal(Object.hasOwn(workspace.newTaskDrafts.sol, "prefillSource"), false);
  assert.equal(saves, 1);
  const restoredEmpty = normalizeTaskWorkspace(JSON.parse(JSON.stringify(workspace)));
  assert.equal(Object.hasOwn(restoredEmpty.newTaskDrafts.sol, "englishDiarySourcePath"), false);
  console.log("PASS actual Composer save: clearing text removes the diary source and prefill origin before persistence.");
}

function scopeHelpersAndToolSelection(): void {
  for (const invalid of [null, undefined, "", "/absolute.md", "../outside.md", "Daily/../outside.md", "Daily//entry.md", "Daily/./entry.md", "Daily\\entry.md", "C:entry.md", "Daily/entry.txt", "Daily/private\u0000.md"]) {
    assert.equal(normalizeEnglishDiarySourcePath(invalid), null, `reject invalid scope ${JSON.stringify(invalid)}`);
  }
  for (const valid of [SOURCE, "原稿/今天.MD"]) assert.equal(normalizeEnglishDiarySourcePath(valid), valid);
  const invalidDraft = normalizeTaskWorkspace({ newTaskDrafts: { sol: { text: PROMPT, attachments: [], englishDiarySourcePath: "../outside.md" } } });
  assert.equal(Object.hasOwn(invalidDraft.newTaskDrafts.sol, "englishDiarySourcePath"), false, "stored drafts cannot restore an unsafe source path");
  const context = { sourcePath: SOURCE, intentEntryId: "intent-1" };
  const built = buildEnglishDiaryTaskContext(context);
  context.sourcePath = OTHER_SOURCE;
  assert.equal(built.details.sourcePath, SOURCE);
  assert.equal(built.customType, ENGLISH_DIARY_TASK_CONTEXT); assert.equal(built.display, false);
  assert.match(built.content, /english_diary_generate/); assert.doesNotMatch(built.content, new RegExp(SECRET));
  assert.deepEqual(englishDiaryTaskContextFromEntries([
    { type: "custom_message", ...built },
    { type: "custom_message", customType: ENGLISH_DIARY_TASK_CONTEXT, details: { sourcePath: "../outside.md" } },
    { type: "custom_message", customType: "unrelated", details: { sourcePath: OTHER_SOURCE } }
  ]), { sourcePath: SOURCE, intentEntryId: "intent-1" });
  assert.deepEqual(englishDiaryTaskContextFromEntries([
    { type: "custom_message", ...built },
    { type: "custom_message", customType: ENGLISH_DIARY_TASK_CONTEXT, details: { sourcePath: OTHER_SOURCE, sourceBody: SECRET } }
  ]), { sourcePath: OTHER_SOURCE }, "restoration uses the newest valid scope and never restores arbitrary body fields");
  assert.equal(englishDiaryTaskContextFromEntries([{ type: "custom", ...built }]), null);

  const tools = {
    commandKind: "chat" as const, englishDiary: true, mode: "agent" as const, permission: "workspace-write" as const, memoryMode: "normal" as const,
    defaultToolNames: ["note_read", "note_write", "english_diary_generate", "knowledge_read", "memory_write", "english_diary_generate"],
    memoryToolNames: ["memory_write"], planToolNames: ["note_read", "task_update"], externalReadToolNames: ["web_search"]
  };
  assert.deepEqual(resolvePiTurnToolNames(tools), ["english_diary_generate"]);
  assert.deepEqual(resolvePiTurnToolNames({ ...tools, mode: "plan" }), []);
  assert.deepEqual(resolvePiTurnToolNames({ ...tools, permission: "read-only" }), []);
  assert.deepEqual(resolvePiTurnToolNames({ ...tools, permission: undefined }), []);
  assert.deepEqual(resolvePiTurnToolNames({ ...tools, defaultToolNames: ["note_write"] }), [], "the diary tool is never invented when capability publication excludes it");
  assert.deepEqual(resolvePiTurnToolNames({ ...tools, memoryMode: "no_memory" }), ["english_diary_generate"]);
  console.log("PASS scope helpers and actual tool selection: safe paths, newest valid custom entry, exact diary tool, no Plan/read-only writes.");
}

function exactDiaryCapabilityRegression(root: string): void {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.englishDiary.enabled = true;
  const bindings = emptyKnowledgeFolderBindings();
  bindings.roles.journal = { ...bindings.roles.journal, enabled: true, readPaths: ["Daily"], writePath: "Daily" };
  bindings.roles.outputs = { ...bindings.roles.outputs, enabled: true, readPaths: ["outputs"], writePath: "outputs" };
  settings.knowledgeBase.folderBindings = bindings;
  settings.agentRegistry.agents.push({ ...settings.agentRegistry.agents[0], id: "diary-only", name: "英文负责人", capabilityIds: ["journal", "english-diary"], disabledCapabilityIds: [] });
  const context: AgentCapabilityContext = {
    settings, agentId: "diary-only", vaultRoot: root, resources: [], proAccess: paidTestAccess,
    access: { permission: "workspace-write", mode: "agent", memoryMode: "normal" },
    modulePaths: { journal: ["Daily"], "english-diary": ["outputs/英文日记"] }
  };
  const target = { sourcePath: SOURCE, englishPath: "outputs/英文日记/result.md", journalId: "fixture-journal" };
  const generate = (ctx: AgentCapabilityContext) => checkAgentTool(ctx, "english_diary_generate", { sourcePath: SOURCE }, target);
  assert.equal(checkAgentCapability(context, "knowledge").allowed, false, "the test Agent really has no Knowledge grant");
  assert.equal(generate(context).allowed, true, "the precise English output root overrides its generic Knowledge parent");
  assert.equal(checkAgentTool(context, "note_read", { path: "outputs/unrelated.md" }).allowed, false, "the exact diary grant does not authorize the rest of outputs");
  for (const disabled of ["journal", "english-diary"]) {
    const deniedSettings = structuredClone(settings);
    deniedSettings.agentRegistry.agents.find(agent => agent.id === "diary-only")!.capabilityIds = ["journal", "english-diary"].filter(capability => capability !== disabled);
    const denied = generate({ ...context, settings: deniedSettings });
    assert.equal(denied.allowed, false, `Agent ${disabled} capability is required`);
    assert.equal(denied.reason, "agent_disabled");
  }
  const englishOff = structuredClone(settings); englishOff.englishDiary.enabled = false;
  assert.equal(generate({ ...context, settings: englishOff }).reason, "module_disabled");
  const journalOff = structuredClone(settings); journalOff.knowledgeBase.folderBindings!.roles.journal.enabled = false;
  assert.equal(generate({ ...context, settings: journalOff }).reason, "module_disabled");
  assert.equal(generate({ ...context, proAccess: unavailableCapabilityAccess }).reason, "pro_required");
  assert.equal(generate({ ...context, access: { permission: "read-only", mode: "agent", memoryMode: "normal" } }).reason, "read_only");
  assert.equal(generate({ ...context, access: { permission: "workspace-write", mode: "plan", memoryMode: "normal" } }).reason, "read_only");
  console.log("PASS exact capability regression: journal + English Agent can target English output under Knowledge outputs; missing capability/module, expired PRO, read-only and Plan deny generation.");
}

function sourceTemplateBodyRegression(): void {
  const morning = new Date("2027-01-02T09:00:00"), later = new Date("2027-01-02T10:00:00");
  const formats = { templateDateFormat: "YYYY-MM-DD", templateTimeFormat: "HH:mm" };
  const template = "---\ncreated: {{date}}\n---\n# {{title}}\n\n时间：{{time}}\n日期：{{date}}\n目标 3 次\n\n## 今天发生了什么\n";
  const title = "2027-01-02", rendered = renderNativeJournalTemplate(template, morning, title, formats);
  const input = { template, now: later, title, formats };
  assert.match(rendered, /时间：09:00/u, "the fixture uses the real native template renderer");
  assert.equal(hasEnglishDiarySourceContent(rendered, { ...input, now: morning }), false);
  assert.equal(hasEnglishDiarySourceContent(rendered, input), false, "09:00 template remains empty when inspected at 10:00");
  assert.equal(hasEnglishDiarySourceContent(`${rendered}\n今天写下了一件真实发生的事。`, input), true);
  assert.equal(hasEnglishDiarySourceContent(rendered.replace("时间：09:00", "时间：09:00今天确实写了正文"), input), true, "an addition sharing the template line prefix must not be swallowed by its time token");
  assert.equal(hasEnglishDiarySourceContent(rendered.replace("目标 3 次", "目标 4 次"), input), true, "fixed digits outside a date/time token must match exactly");
  const amPmTemplate = "记录时间：{{time:hh:mm A}}", afternoon = new Date("2027-01-02T13:00:00");
  const amPmRendered = renderNativeJournalTemplate(amPmTemplate, morning, title, formats);
  assert.equal(hasEnglishDiarySourceContent(amPmRendered, { template: amPmTemplate, now: afternoon, title, formats }), false, "AM/PM and time digits may vary only inside the token");

  const changedTemplate = "# {{title}}\n\n新模板固定提示：\n新的记录时间：{{time}}";
  const baseline = journalTemplateBaseline(rendered);
  assert.equal(hasEnglishDiarySourceContent(rendered, { ...input, template: changedTemplate }), true, "without saved baseline the old fixed text differs from the current template");
  assert.equal(hasEnglishDiarySourceContent(rendered, { ...input, template: changedTemplate, baseline }), false, "saved creation-time baseline takes priority after the configured template changes");
  assert.equal(hasEnglishDiarySourceContent(`${rendered}\n更换模板后写的正文。`, { ...input, template: changedTemplate, baseline }), true);
  assert.equal(hasEnglishDiarySourceContent(rendered.replace("时间：09:00", "时间：09:00新增中文"), { ...input, baseline }), true);
  for (const empty of ["", " \n\t", "---\nprivate: frontmatter-only\n---\n", "#\n## \n###\n", "---\nprivate: metadata\n---\n# \n## 空标题\n"]) {
    assert.equal(hasEnglishDiarySourceContent(empty, input), false, "zero body, frontmatter and heading scaffolds are not original diary content");
  }
  const emptyTitle = renderNativeJournalTemplate(template, morning, "", formats);
  assert.equal(hasEnglishDiarySourceContent(emptyTitle, { ...input, title: "" }), false);
  console.log("PASS native template source regression: 09:00/10:00 and AM/PM stay empty, real or same-line Chinese additions survive, fixed text is exact, saved baseline wins, and frontmatter/empty headings are not body.");
}

function guardedExtension(scope: { sourcePath: string; intentEntryId?: string }) {
  const materialCalls: string[] = [], handlers = new Map<string, (...args: any[]) => any>();
  const memoryObservations: unknown[] = [];
  let skillPermissionChecks = 0, vaultFactoryCalls = 0;
  const material = (name: string, value: unknown): any => { materialCalls.push(name); return value; };
  const extension = createPiKnowledgeInlineExtension({
    vaultSecurity: { name: "offline-diary-scope-test", factory() { vaultFactoryCalls++; } },
    currentEnglishDiaryRequest: () => scope,
    currentWorkspaceAccess: () => ({ permission: "workspace-write", mode: "agent", memoryMode: "normal" }),
    assertCurrentSkillsAllowed: async () => { skillPermissionChecks++; },
    currentTurn: () => material("knowledge", { kind: "chat", providerResourceText: SECRET, references: [] }),
    currentSkillTurn: () => material("selectedSkill", { skillId: "unrelated-skill", content: SECRET }),
    currentNoteMentionTurn: () => material("noteMention", { noteMentions: [{ vaultRelativePath: "private/mention.md", content: SECRET }] }),
    currentDocumentTurn: () => material("document", { documents: [{ text: SECRET, bytes: new TextEncoder().encode(SECRET) }] }),
    currentSelectionAnnotations: () => material("selection", [{ selectedText: SECRET }]),
    currentMemoryTurn: () => material("memoryTurn", { memoryMode: "normal", query: SECRET, vaultId: "fixture", conversationId: "task", piSessionId: "pi", productRunId: "run" }),
    personalMemory: {
      loadFixedContext: async () => material("personalMemory.loadFixedContext", { revision: 1, agent: SECRET, user: SECRET, injectionKeys: [] }),
      prepareTurnContext: async () => material("personalMemory.prepareTurnContext", { revision: 1, agent: SECRET, user: SECRET, injectionKeys: [] })
    },
    contextLedger: {
      captureBeforeAgentStart() {}, captureTransientContextMessages() {},
      capturePersonalMemoryAccess(value) { memoryObservations.push(value); }
    }
  } as Parameters<typeof createPiKnowledgeInlineExtension>[0]);
  return { extension, handlers, materialCalls, memoryObservations, counts: () => ({ skillPermissionChecks, vaultFactoryCalls }) };
}

async function extensionAndColdRecovery(root: string): Promise<void> {
  const stableIntent = "english-diary:fixture-conversation";
  const scoped = guardedExtension({ sourcePath: SOURCE, intentEntryId: stableIntent });
  await scoped.extension.factory({ on: (name: string, handler: (...args: any[]) => any) => scoped.handlers.set(name, handler) } as never);
  assert.ok(scoped.handlers.has("before_agent_start"), "the actual production extension registered the callback");
  const before = await scoped.handlers.get("before_agent_start")!({ systemPrompt: "Fixed offline system", prompt: PROMPT });
  assert.deepEqual(scoped.materialCalls, [], "diary requests bypass every unrelated Provider-material builder");
  assert.deepEqual(scoped.counts(), { skillPermissionChecks: 1, vaultFactoryCalls: 1 }, "the real permission check still runs");
  assert.deepEqual(scoped.memoryObservations, [{ mode: "not_applicable", effectiveMode: "not_applicable", capability: "not_applicable", fixedContextRevision: null }]);
  assert.equal(before.message.customType, ENGLISH_DIARY_TASK_CONTEXT);
  assert.equal(before.message.display, false);
  assert.deepEqual(before.message.details, { sourcePath: SOURCE, intentEntryId: stableIntent });
  assert.doesNotMatch(JSON.stringify(before), new RegExp(SECRET));
  assert.match(before.systemPrompt, /Fixed offline system/);
  console.log("PASS production before_agent_start: no Personal Memory, Knowledge, note mention, document, selection or selected Skill material is built; no secret sentinel is returned.");

  const sessionRoot = path.join(root, "pi-sessions");
  const api = { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION,
    open: (file: string, directory: string, cwd: string) => SessionManager.open(file, directory, cwd) };
  const session = createDurablePiSession({ api, sessionRoot, cwd: root, sessionFileName: "diary-context.jsonl" });
  session.sessionManager.appendMessage({ role: "user", content: PROMPT, timestamp: 1 });
  session.sessionManager.appendCustomMessageEntry(before.message.customType, before.message.content, before.message.display, before.message.details);
  persistPiActiveLeaf({ sessionRoot, sessionManager: session.sessionManager });
  const disk = await readFile(session.sessionFile, "utf8");
  assert.doesNotMatch(disk, new RegExp(SECRET));
  const reopened = openDurablePiSession({ api, sessionRoot, sessionFile: session.sessionFile, cwd: root });
  const restored = englishDiaryTaskContextFromEntries(reopened.sessionManager.getBranch());
  assert.deepEqual(restored, { sourcePath: SOURCE, intentEntryId: stableIntent });
  const cold = guardedExtension(restored!);
  await cold.extension.factory({ on: (name: string, handler: (...args: any[]) => any) => cold.handlers.set(name, handler) } as never);
  const continued = await cold.handlers.get("before_agent_start")!({ systemPrompt: "Fixed offline system", prompt: "继续" });
  assert.deepEqual(continued.message.details, before.message.details);
  assert.deepEqual(cold.materialCalls, []); assert.doesNotMatch(JSON.stringify(continued), new RegExp(SECRET));
  console.log("PASS real Pi persistence and cold recovery: the accepted source scope survives JSONL reopen and the resumed callback keeps material isolation.");

  // Control: the fake event host invokes real material assembly when no diary request is active.
  const ordinaryHandlers = new Map<string, (...args: any[]) => any>();
  let ordinaryKnowledgeReads = 0;
  const ordinary = createPiKnowledgeInlineExtension({ vaultSecurity: () => {}, currentEnglishDiaryRequest: () => null,
    currentTurn: () => { ordinaryKnowledgeReads++; return { kind: "chat", providerResourceText: "ORDINARY_KNOWLEDGE_CONTROL", references: [] }; } });
  await ordinary.factory({ on: (name: string, handler: (...args: any[]) => any) => ordinaryHandlers.set(name, handler) } as never);
  const ordinaryBefore = await ordinaryHandlers.get("before_agent_start")!({ systemPrompt: "Fixed offline system", prompt: "查笔记" });
  assert.equal(ordinaryKnowledgeReads, 1); assert.equal(ordinaryBefore.message.content, "ORDINARY_KNOWLEDGE_CONTROL");
  console.log("PASS ordinary-turn control: the same extension still builds Knowledge material when the diary-only branch is absent.");
}

export async function runEnglishDiaryTaskContextTests(root: string): Promise<void> {
  await draftScopeLifecycle(root);
  scopeHelpersAndToolSelection();
  exactDiaryCapabilityRegression(root);
  sourceTemplateBodyRegression();
  await extensionAndColdRecovery(root);
  console.log("P9 English diary task-context integration: all checks passed (offline; no Provider or native UI acceptance claimed).");
}
