import assert from "node:assert/strict";
import { agentCapabilityErrorText, knownAgentCapabilityDenial } from "../agents/capability-denial";
import { checkAgentCapability } from "../agents/capability-policy";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { KnowledgeAgentIndex } from "../knowledge-base/knowledge-agent-index";
import { createPiAgentCapabilityContext, createProductionPiKnowledgeRuntime } from "../plugin/pi-production-runtime-composition";
import { CodexView } from "../ui/codex-view";
import { renderAgentTaskList } from "../ui/codex-view/task-list";
import { renderTaskInterruption } from "../ui/codex-view/task-interruption";
import { disposeOriginControls } from "../settings/origin-controls";

export async function runTaskCardDenialTests(f: any, doc: Document): Promise<void> {
  const view: any = new CodexView({} as never, f.plugin);
  view.rootEl = doc.body.createDiv();
  for (const field of ["tabBarEl", "taskListEl", "taskDetailEl", "taskEditorEl", "taskErrorEl", "taskInterruptionEl", "taskPlanDockEl", "interactionDockEl", "queueEl"]) view[field] = view.rootEl.createDiv();
  view.messagesEl = view.rootEl.createDiv().createDiv(); view.inputEl = view.rootEl.createDiv().createEl("textarea");
  view.taskUiMounted = true; view.updateInputPlaceholder = view.renderComposerTransfers = () => undefined;
  view.taskNavigation.navigate({ kind: "list", agentId: "sol" });
  const entry = { ...(await f.catalog.get("A")), taskStatus: "completed", title: "visible" };
  view.taskEntries = [entry, { ...entry, conversationId: "archived-card", status: "archived" }, { ...entry, conversationId: "deleted-card", status: "deleted" }];
  const inline = f.plugin.inlineAgent;
  const requests = ["archived-card", "deleted-card"].map(taskId => ({ taskId, id: taskId, agentId: "sol", status: "pending", createdAt: 1, updatedAt: 2 }));
  f.plugin.inlineAgent = { service: { list: () => requests, latestForTask: (id: string) => requests.find(request => request.taskId === id) } };
  view.renderTaskPages();
  f.plugin.inlineAgent = inline;
  assert.equal(view.taskListEl.querySelectorAll(".echoink-task-card").length, 1);
  assert.equal(view.taskListEl.querySelector(".echoink-agent-task-count").textContent, "1 件事");
  let target = "";
  const session = f.settings.sessions.find((item: any) => item.id === "A");
  renderAgentTaskList(view.taskListEl, f.settings.agentRegistry.agents[0], [entry], [session], {
    onTask() {}, onEdit() {}, onSessionMenu(event, value) { event.preventDefault(); target = value.id; }
  });
  const card = view.taskListEl.querySelector(".echoink-task-card");
  const event = new doc.defaultView!.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  card.dispatchEvent(event); assert.equal(target, "A"); assert.equal(event.defaultPrevented, true);
  renderAgentTaskList(view.taskListEl, f.settings.agentRegistry.agents[0], [entry], [], { onTask() {}, onEdit() {}, onSessionMenu() { throw new Error("virtual card must not open a session menu"); } });
  assert.equal(view.taskListEl.querySelector(".echoink-task-card").oncontextmenu, null);
  disposeOriginControls(view.rootEl); view.rootEl.remove();

  const agent = f.settings.agentRegistry.agents.find((item: any) => item.id === "colleague");
  const granted = agent.capabilityIds, bindings = f.settings.knowledgeBase.folderBindings, language = f.settings.settingsLanguage;
  const mount = doc.body.createDiv();
  try {
    const runtime = createProductionPiKnowledgeRuntime({ vaultRootPath: f.plugin.getVaultPath(),
      knowledgeAgentIndex: new KnowledgeAgentIndex({ vaultPath: f.plugin.getVaultPath(), storageRootPath: `${f.plugin.getVaultPath()}/denial-index` }),
      knowledgePreferences: {} as never, usage: {} as never,
      conversationKnowledgeDecision: async () => checkAgentCapability(createPiAgentCapabilityContext(f.plugin, "colleague", []), "knowledge") });
    for (const en of [false, true]) for (const cause of ["agent_disabled", "module_disabled"] as const) {
      f.settings.settingsLanguage = en ? "en" : "zh-CN";
      agent.capabilityIds = cause === "agent_disabled" ? [] : ["knowledge"];
      f.settings.knowledgeBase.folderBindings = emptyKnowledgeFolderBindings();
      await assert.rejects(runtime.retrieveAsk({ vaultId: "agent-runs", conversationId: "A", piSessionId: "s", productRunId: "denied", question: "test", explicitPaths: [], includeUnrefined: false }), error => {
        assert.equal(knownAgentCapabilityDenial(error)?.reason, cause);
        assert.match(agentCapabilityErrorText(error, f.settings.settingsLanguage)!, en ? /Knowledge.*disabled/ : /知识库.*关闭/u); return true;
      });
    }
    f.settings.knowledgeBase.folderBindings = bindings; agent.capabilityIds = granted;
    await f.service.run(f.item("C", "accepted before revocation"));
    await f.plugin.setPiConversationTaskMetadata("C", { taskStatus: "interrupted", taskInterruptedAt: Date.now() });
    agent.capabilityIds = [];
    for (const en of [false, true]) {
      f.settings.settingsLanguage = en ? "en" : "zh-CN";
      const info = await f.plugin.readTaskInterruption("C");
      assert.equal(info.resumeBlocked, true);
      renderTaskInterruption(mount, { info, pending: false, language: f.settings.settingsLanguage, onResume() { throw new Error("denied resume"); } });
      assert.equal(mount.querySelector("[data-action=resume-task]"), null);
      renderTaskInterruption(mount, { info: { ...info, uncertainOperations: [{ id: "pending-write", label: "核对原操作" }] }, pending: false, language: f.settings.settingsLanguage, onResume() {} });
      assert.match(mount.querySelector(".echoink-task-interruption-operations")!.textContent!, /核对原操作/u);
      assert.doesNotMatch(mount.textContent!, /agent_capability_|意外中断|unexpected.*interrupt/iu);
      assert.match(mount.textContent!, en ? /Knowledge.*disabled/ : /知识库.*关闭/u);
    }
    agent.capabilityIds = granted;
    const reopened = await f.plugin.readTaskInterruption("C");
    assert.equal(reopened.resumeBlocked, undefined, "current policy is re-read, without persisting a new task state");
    renderTaskInterruption(mount, { info: reopened, pending: false, language: "en", onResume() {} });
    assert.ok(mount.querySelector("[data-action=resume-task]"));
    for (const code of ["agent_capability_catalog_missing", "agent_capability_workspace_unavailable", "tool_policy_blocked"]) assert.equal(agentCapabilityErrorText(code, "zh-CN"), undefined);
  } finally {
    agent.capabilityIds = granted; f.settings.knowledgeBase.folderBindings = bindings; f.settings.settingsLanguage = language;
    await f.plugin.setPiConversationTaskMetadata("C", { taskStatus: "completed", taskInterruptedAt: undefined, taskCompletedAt: Date.now() });
    disposeOriginControls(mount); mount.remove();
  }
  console.log("Task card + denial: active-only counts, real-session context menu, reason-preserving preflight, current-policy resume, bilingual copy PASS");
}
