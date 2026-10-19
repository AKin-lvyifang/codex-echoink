import assert from "node:assert/strict";
import { mkdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { nativeJournalFixture } from "./native-journal-fixture";
import { EchoInkTodoStore, TODO_SOURCE_PATH } from "../home/todo-store";
import { getTodoProjects } from "../home/todo-projects";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { checkAgentSkill, checkAgentSkillPath, checkAgentTool, requireAgentCapability, type AgentCapabilityContext } from "../agents/capability-policy";
import { GENERAL_ASSISTANT_ID } from "../agents/types";
import { unavailableCapabilityAccess } from "../membership/access";
import { createPiTodoToolDefinitions, PiTodoToolSecurity, PI_TODO_TOOL_IDS } from "../harness/pi-native/pi-todo-tools";
import { normalizeTodoToolRequest } from "../harness/pi-native/todo-tool-policy";
import { FileApprovalTicketStore } from "../harness/pi-native/tool-authorization";
import { FileDomainReceiptStore } from "../harness/pi-native/domain-receipt-store";
import { getBuiltinSkillDefinition } from "../harness/resources/builtin-skills";
import type { EchoInkResource } from "../resources/types";
import type { PiWorkspaceAccess } from "../harness/pi-native/pi-workspace-access";

export async function runTodoToolTests(root: string): Promise<void> {
  const f = await nativeJournalFixture(root);
  const bindings = emptyKnowledgeFolderBindings();
  bindings.roles.projects = { enabled: true, readPaths: ["工作项目", "生活项目"], writePath: "工作项目", allowedSubdirectories: [] };
  f.plugin.settings.knowledgeBase.folderBindings = bindings;
  await Promise.all(["工作项目/EchoInk", "生活项目/EchoInk", "工作项目/空项目", "工作项目/EchoInk/子目录"].map(dir => mkdir(path.join(root, dir), { recursive: true })));
  await f.write("工作项目/不是项目.md", "ordinary note");
  const legacy = [{ id: "legacy", title: "Must not migrate during read", done: false }];
  f.plugin.settings.todos = structuredClone(legacy);
  const store = new EchoInkTodoStore(f.plugin);
  const source = () => readFile(path.join(root, TODO_SOURCE_PATH), "utf8");
  let sourceWrites = 0, settingsWrites = 0, confirms = 0, seq = 0;
  const process = f.app.vault.process.bind(f.app.vault), create = f.app.vault.create.bind(f.app.vault);
  f.app.vault.process = async (...args) => { sourceWrites++; return await process(...args); };
  f.app.vault.create = async (...args) => { sourceWrites++; return await create(...args); };
  f.plugin.saveSettings = async () => { settingsWrites++; };
  store.initialize = async () => { throw new Error("Agent tools must not initialize the store"); };
  let access: PiWorkspaceAccess = { permission: "workspace-write", mode: "agent", memoryMode: "normal" };
  let identity = { vaultId: "todo-tool-fixture", conversationId: "conversation", piSessionId: "session", productRunId: "run-1" };
  let entry = { entryId: "entry-1", text: "新增一条待办" };
  let includeRuntimeContext = false, runtimeIdentityReads = 0;
  let accepted = true;
  let confirmationEffect: (() => void | Promise<void>) | undefined;
  const resource: EchoInkResource = { id: "builtin:todo-operations", name: "待办安排", kind: "skill", source: "manual", enabled: true, description: "fixture", contentPath: "EchoInk/Skills/todo-operations/SKILL.md", metadata: { resourceId: "todo-operations" } };
  const resources = [resource];
  const context = (): AgentCapabilityContext => ({ settings: f.plugin.settings, agentId: GENERAL_ASSISTANT_ID, vaultRoot: root, resources, access, proAccess: unavailableCapabilityAccess });
  const agent = f.plugin.settings.agentRegistry.agents.find((item: { id: string }) => item.id === GENERAL_ASSISTANT_ID)!;
  const approvals = new FileApprovalTicketStore({ storageRootPath: path.join(root, ".pi"), vaultId: identity.vaultId });
  const receipts = new FileDomainReceiptStore({ storageRootPath: path.join(root, ".pi"), vaultId: identity.vaultId });
  await approvals.initialize(); await receipts.initialize();
  const assertions: Array<{ tool: string; operation?: Readonly<{ productRunId: string; toolCallId: string }> }> = [];
  const options = { assertToolAllowed: async (tool: string, args: Readonly<Record<string, unknown>>, target?: unknown, operation?: Readonly<{ productRunId: string; toolCallId: string }>) => {
    assertions.push({ tool, operation }); requireAgentCapability(checkAgentTool(context(), tool, args, target));
  }, currentAccess: () => access, currentRunIdentity: () => includeRuntimeContext ? ({ ...identity, userEntryId: entry.entryId, userEntryText: "runtime-only-user-context", runtimeExtra: { read: ++runtimeIdentityReads } }) : ({ ...identity }), currentUserEntry: () => entry, approvals, receipts, userId: "fixture-user", deviceId: "fixture-device", confirmation: { async confirm(request: any) {
    confirms++; assert.equal(request.target.relativePath, TODO_SOURCE_PATH); assert.equal(request.preview.domain, "todos");
    await confirmationEffect?.(); return accepted;
  } } };
  const port = { store, projects: () => getTodoProjects(f.plugin) };
  let security: PiTodoToolSecurity;
  let tools: ReturnType<typeof createPiTodoToolDefinitions>;
  function restart() { security = new PiTodoToolSecurity(options); tools = createPiTodoToolDefinitions(port, security); }
  restart();
  function nextIntent(text = "处理这条待办") { const n = ++seq; identity = { ...identity, productRunId: `run-${n + 10}` }; entry = { entryId: `entry-${n + 10}`, text }; }
  async function call(toolName: string, input: Record<string, unknown>, between?: () => Promise<void>) {
    const event = { toolName, toolCallId: `call-${++seq}`, input } as any;
    const blocked = await security.handleToolCall(event);
    if (blocked) return { blocked: true, reason: blocked.reason } as any;
    await between?.();
    const raw = await tools.find(tool => tool.name === toolName)!.execute(event.toolCallId, input, undefined, undefined);
    const result = await security.handleToolResult({ ...event, ...raw, isError: false } as any);
    return { ...JSON.parse(result.content[0].text), isError: result.isError, toolCallId: event.toolCallId } as any;
  }

  const missing = await call("todo_query", {});
  assert.equal(missing.exists, false); assert.equal(missing.contentVersion, null);
  assert.equal(sourceWrites, 0); assert.equal(settingsWrites, 0); assert.deepEqual(f.plugin.settings.todos, legacy);
  const initial = "User heading stays\n- [ ] Existing <!-- echoink-todo-id: existing -->\n  - 项目：Gone project\n  - 未知：keep\n- [ ] Handwritten without id\n";
  await f.write(TODO_SOURCE_PATH, initial);
  const beforeReadStat = await stat(path.join(root, TODO_SOURCE_PATH));
  const queried = await call("todo_query", {});
  assert.equal(queried.todos[1].id, ""); assert.equal(queried.todos[1].editable, false);
  assert.equal(queried.todos[0].projectStatus, "missing");
  assert.deepEqual(queried.projects.map((p: any) => p.path).sort(), ["工作项目/EchoInk", "工作项目/空项目", "生活项目/EchoInk"].sort());
  assert.equal(await source(), initial); assert.equal((await stat(path.join(root, TODO_SOURCE_PATH))).mtimeMs, beforeReadStat.mtimeMs);
  assert.equal(sourceWrites, 0); assert.equal(settingsWrites, 0); assert.deepEqual(f.plugin.settings.todos, legacy);

  for (const limited of [{ ...access, permission: "read-only" as const }, { ...access, mode: "plan" as const }]) {
    access = limited;
    assert.equal((await call("todo_query", {})).status, "completed");
    assert.equal((await call("todo_add", { title: "Denied" })).blocked, true);
  }
  access = { permission: "workspace-write", mode: "agent", memoryMode: "normal" };
  agent.disabledCapabilityIds = ["todos"];
  for (const tool of PI_TODO_TOOL_IDS) assert.equal(checkAgentTool(context(), tool).allowed, false, `${tool} hidden-tool path must deny`);
  assert.equal((await call("todo_add", { title: "Capability off" })).blocked, true);
  assert.equal((await call("todo_query", {})).blocked, true);
  assert.equal(checkAgentSkill(context(), "todo-operations").reason, "agent_disabled");
  assert.equal(checkAgentSkillPath(context(), resource.contentPath!).reason, "agent_disabled");
  agent.disabledCapabilityIds = [];
  assert.equal(checkAgentSkill(context(), "todo-operations").allowed, true);
  assert.equal(checkAgentTool(context(), "todo_add", { title: "Free local todos" }).allowed, true, "todos retain existing free-module rules");
  resource.enabled = false; assert.equal(checkAgentSkill(context(), "todo-operations").reason, "resource_disabled"); resource.enabled = true;
  assert.ok(getBuiltinSkillDefinition("todo-operations")?.body.includes("todo_complete"));
  assert.equal(sourceWrites, 0); assert.equal(settingsWrites, 0);
  assert.equal((await call("todo_add", { title: "Invalid project", project: "EchoInk" })).reason, "todo_project_ambiguous");
  assert.equal((await call("todo_add", { title: "Invalid project", project: "工作项目/EchoInk/子目录" })).reason, "todo_project_missing");
  accepted = false;
  assert.equal((await call("todo_add", { title: "Rejected" })).reason, "approval_denied");
  assert.equal(await source(), initial); assert.equal(sourceWrites, 0); assert.equal(settingsWrites, 0);
  accepted = true;
  includeRuntimeContext = true;
  nextIntent("为工作项目EchoInk新增待办");
  const addition = { title: "Submit report", project: "工作项目/EchoInk", dueDate: "2026-10-21", dueTime: "14:30", people: "同事", categoryName: "工作" };
  const created = await call("todo_add", addition);
  assert.equal(created.status, "completed", JSON.stringify(created)); assert.equal(created.readbackVerified, true);
  assert.equal(created.todo.project, "工作项目/EchoInk"); assert.equal(created.todo.dueTime, "14:30"); assert.ok(created.todo.id);
  assert.equal((await call("todo_query", { project: "工作项目/EchoInk" })).todos.length, 1);
  assert.equal((await call("todo_query", { project: "", status: "open" })).todos.length, 1);
  assert.equal((await call("todo_query", { query: "submit", limit: 1 })).todos[0].id, created.todo.id);
  const afterCreate = await source();
  assert.match(afterCreate, /User heading stays/); assert.match(afterCreate, /未知：keep/);
  const receipt = (await receipts.listUiViews({ conversationId: identity.conversationId })).find(row => row.operationIdentity === created.operationIdentity)!;
  assert.equal(receipt.receipt?.status, "completed");
  assert.equal(receipt.receipt?.readback.observedTargetVersion, (await store.readOnlySnapshot()).contentVersion);
  assert.equal((receipt.receipt?.targetVersion as any).beforeVersion, queried.contentVersion);
  assert.equal((receipt.resolvedTarget as any).relativePath, TODO_SOURCE_PATH);
  const ticket = (await approvals.listReadOnlyViews({ conversationId: identity.conversationId })).find(row => row.ticket.operationIdentity === created.operationIdentity)!.ticket;
  const journal = await receipts.readOperation(created.operationIdentity);
  for (const persisted of [ticket, journal, receipt.receipt]) {
    assert.ok(persisted);
    for (const key of ["userEntryId", "userEntryText", "runtimeExtra"]) assert.equal(Object.hasOwn(persisted!, key), false, `runtime ${key} must not enter the approval/receipt contract`);
    assert.equal(JSON.stringify(persisted).includes("runtime-only-user-context"), false);
  }
  assert.equal((await call("todo_add", addition)).reason, "todo_operation_already_completed_query");
  restart();
  nextIntent("继续刚才的操作");
  assert.equal((await call("todo_add", addition)).reason, "todo_operation_already_completed_query");
  assert.equal(await source(), afterCreate, "restart/continue must not duplicate an add");
  nextIntent("另加一条完全相同的待办");
  assert.equal((await call("todo_add", addition)).status, "completed", "new explicit intent may add the same content");

  nextIntent("新增每周报告待办");
  const omitted = { title: "Write weekly report" };
  const explicitEmpty = { ...omitted, people: "", dueDate: "", dueTime: "", categoryName: "", project: "" };
  assert.equal((await call("todo_add", omitted)).status, "completed");
  const beforeEmptyRetry = await source();
  assert.equal((await call("todo_add", explicitEmpty)).reason, "todo_operation_already_completed_query", "omitted and explicit empty fields describe the same add");
  assert.equal(await source(), beforeEmptyRetry, "semantic retry must not append a second record");
  restart();
  assert.equal((await call("todo_add", explicitEmpty)).reason, "todo_operation_already_completed_query", "semantic add identity survives reopening the receipt store");
  nextIntent("新增另一个每周报告待办");
  const explicitFirst = { ...explicitEmpty, title: "Write next weekly report" };
  assert.equal((await call("todo_add", explicitFirst)).status, "completed");
  assert.equal((await call("todo_add", { title: explicitFirst.title })).reason, "todo_operation_already_completed_query", "explicit empty then omitted fields are equivalent too");
  nextIntent("新增有日期但未指定时间的待办");
  const dateOnly = { title: "Review dated report", dueDate: "2026-10-25" };
  const dated = await call("todo_add", dateOnly);
  assert.equal(dated.status, "completed");
  assert.equal((await call("todo_add", { ...dateOnly, dueTime: "" })).reason, "todo_operation_already_completed_query", "omitted and empty dueTime both store no time metadata");
  nextIntent("清除这条待办日期");
  assert.equal((await call("todo_update", { id: dated.todo.id, patch: { dueDate: "" } })).status, "completed");
  assert.equal((await call("todo_update", { id: dated.todo.id, patch: { dueDate: "", dueTime: "17:00" } })).reason, "todo_operation_already_completed_query", "clearing the date discards stale time exactly as TodoStore does");
  assert.deepEqual(normalizeTodoToolRequest("todo_add", omitted), normalizeTodoToolRequest("todo_add", explicitEmpty), "P4 compares old and current arguments with the same normalization");
  assert.notDeepEqual(normalizeTodoToolRequest("todo_update", { id: "existing", patch: { people: "" } }), normalizeTodoToolRequest("todo_update", { id: "existing", patch: { title: "Existing" } }), "update omission must not collapse into clearing an existing value");

  nextIntent("把原事项改到明天");
  const revised = await call("todo_update", { id: "existing", patch: { dueDate: "2026-10-22", dueTime: "09:15" } });
  assert.equal(revised.status, "completed", JSON.stringify(revised));
  assert.equal(revised.todo.project, "Gone project", "editing deadline preserves invalid project metadata");
  assert.match(await source(), /未知：keep/);
  nextIntent("完成原事项");
  const completed = await call("todo_complete", { id: "existing" });
  assert.equal(completed.status, "completed", JSON.stringify(completed)); assert.equal(completed.todo.done, true);
  assert.equal((await call("todo_query", { status: "completed" })).todos[0].id, "existing");
  assert.equal(store.completionStatistics().total, 1);
  nextIntent("取消完成");
  assert.equal((await call("todo_complete", { id: "existing", done: false })).todo.done, false);
  assert.equal((await call("todo_query", { id: "existing" })).todos.length, 1);

  nextIntent("改期但保留手工变更");
  const conflict = await call("todo_update", { id: "existing", patch: { dueDate: "2026-10-23" } }, async () => { await f.write(TODO_SOURCE_PATH, (await source()) + "External edit after approval\n"); });
  assert.equal(conflict.status, "failed", JSON.stringify(conflict)); assert.equal(conflict.reason, "todo_source_changed");
  assert.match(await source(), /External edit after approval/);
  assert.equal((await store.readOnlySnapshot()).records.find(record => record.id === "existing")!.dueDate, "2026-10-22");
  assert.equal((await receipts.listUiViews()).find(row => row.toolCallId === conflict.toolCallId)?.effectState, "authorized");

  nextIntent("保存前关闭能力");
  const beforeRevoke = await source();
  confirmationEffect = () => { agent.disabledCapabilityIds = ["todos"]; };
  const revoked = await call("todo_add", { title: "Must not write after revoke" });
  confirmationEffect = undefined; agent.disabledCapabilityIds = [];
  assert.equal(revoked.status, "failed"); assert.match(revoked.reason, /agent_capability_agent_disabled/); assert.equal(await source(), beforeRevoke);
  nextIntent("保存前改为只读");
  confirmationEffect = () => { access = { ...access, permission: "read-only" }; };
  const readOnly = await call("todo_add", { title: "Must not write in read-only" });
  confirmationEffect = undefined; access = { ...access, permission: "workspace-write" };
  assert.equal(readOnly.status, "failed"); assert.equal(await source(), beforeRevoke);

  nextIntent("验证实际写入边界并发改动");
  const instrumentedProcess = f.app.vault.process;
  f.app.vault.process = async (file, transform) => { await f.write(TODO_SOURCE_PATH, (await source()) + "Changed at process boundary\n"); return await instrumentedProcess(file, transform); };
  const raced = await call("todo_update", { id: "existing", patch: { dueDate: "2026-10-24" } });
  f.app.vault.process = instrumentedProcess;
  assert.equal(raced.status, "failed", JSON.stringify(raced)); assert.equal(raced.reason, "todo_source_changed");
  assert.match(await source(), /Changed at process boundary/);
  assert.equal((await store.readOnlySnapshot()).records.find(record => record.id === "existing")!.dueDate, "2026-10-22");

  nextIntent("新增一条回读失败的待办");
  const normalRead = store.readOnlySnapshot.bind(store);
  let reads = 0;
  store.readOnlySnapshot = async () => { if (++reads === 3) throw new Error("readback unavailable after write"); return await normalRead(); };
  const uncertainInput = { title: "Saved but readback unavailable" };
  const uncertain = await call("todo_add", uncertainInput);
  store.readOnlySnapshot = normalRead;
  assert.equal(uncertain.status, "uncertain", JSON.stringify(uncertain));
  assert.equal((await normalRead()).records.filter(record => record.title === uncertainInput.title).length, 1);
  restart(); nextIntent("重试刚才的新增");
  const uncertainBefore = await source();
  assert.equal((await call("todo_add", { ...explicitEmpty, ...uncertainInput })).reason, "todo_previous_result_uncertain_do_not_retry", "explicit empty fields cannot replay an uncertain minimal add");
  assert.equal(await source(), uncertainBefore);
  const operationQuery = await call("todo_query", {});
  assert.ok(operationQuery.operations.some((item: any) => item.operationIdentity === uncertain.operationIdentity && item.status === "uncertain"));
  assert.ok(assertions.every(item => item.operation?.toolCallId && item.operation.productRunId), "P4 assertions must carry current operation identity");
  assert.ok(confirms >= 8, "actual approval port is used on writes");
  for (const args of [{ title: "x", confirmed: true }, { title: "x\n- [ ] injected" }, { title: "x <!-- echoink-todo-id: injected -->" }, { title: "x", dueDate: "2026-02-30" }]) {
    assert.throws(() => normalizeTodoToolRequest("todo_add", args), /todo_invalid/);
  }
  console.log("PASS todo tools: actual TodoStore + FileApprovalTicketStore + FileDomainReceiptStore; zero-write/migration-free reads, capability and hidden Skill gates, approval/rejection, project choices, stable-ID add/reschedule/complete, completion history, post-confirmation revocation/version conflicts, durable duplicate and uncertain replay prevention");
}
