import assert from "node:assert/strict";
import { SessionManager, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { PiTaskPlanToolSecurity, createPiTaskPlanToolDefinition } from "../harness/pi-native/pi-task-plan";
import { latestTaskPlanFromBranch } from "../types/task-plan";
import { normalizeSettingsData } from "../settings/settings";
import { normalizeTaskWorkspace } from "../agents/task-workspace";
import { selectComposerMode, persistComposerDefaults } from "../ui/codex-view/composer-controller";
import { createPiVaultToolSecurityAdapter } from "../harness/pi-native/pi-vault-tool-security-extension";

export async function runPlanModeTests(): Promise<void> {
  const { settings, changed } = normalizeSettingsData({ defaultMode: "plan", taskWorkspace: {
    page: { kind: "detail", taskId: "existing" }, replyDrafts: { existing: { text: "", attachments: [], selectedMode: "plan" } }
  } });
  assert.equal(settings.defaultMode, "agent");
  assert.equal(changed, true);
  assert.equal(settings.taskWorkspace.replyDrafts.existing.selectedMode, "plan", "migration preserves this conversation's explicit mode");
  let saves = 0;
  const host = { selectedMode: "agent" as "agent" | "plan", selectedModel: "", selectedPermission: "read-only",
    plugin: { settings, async saveSettings() { saves++; } }, renderToolbar() {},
    onInputChanged() { settings.taskWorkspace.replyDrafts.existing.selectedMode = host.selectedMode; }
  };
  selectComposerMode(host as never, "plan");
  const queued = { mode: host.selectedMode };
  selectComposerMode(host as never, "agent");
  assert.equal(queued.mode, "plan", "already queued turns retain their own mode");
  assert.equal(settings.defaultMode, "agent");
  assert.equal(normalizeTaskWorkspace(settings.taskWorkspace).replyDrafts.existing.selectedMode, "agent");
  host.selectedMode = "plan";
  persistComposerDefaults(host as never);
  assert.equal(settings.defaultMode, "agent", "changing another composer preference must not save Plan globally");
  assert.equal(saves, 1);

  const manager = SessionManager.inMemory();
  let runId = "plan-validation";
  const security = new PiTaskPlanToolSecurity({ sessionManager: manager,
    currentRun: () => ({ conversationId: "test", piSessionId: manager.getSessionId(), productRunId: runId, mode: "plan" }) });
  const adapter = createPiVaultToolSecurityAdapter({ authorization: { async authorize() { throw new Error("unexpected write authorization"); } },
    resultCorrection: { async correct() { throw new Error("unexpected write correction"); } }, additionalToolSecurity: security });
  const handlers = new Map<string, (event: unknown, context?: unknown) => Promise<unknown>>();
  await adapter.inlineExtension.factory({ on: (name: string, handler: (event: unknown, context?: unknown) => Promise<unknown>) => handlers.set(name, handler) } as never);
  const draft = { planId: "学习计划", title: "学习欧姆定律", status: "pending", steps: [{ stepId: "第一步", text: "理解关系", status: "pending" }] };
  const call = (id: string, input: unknown) => ({ type: "tool_call", toolCallId: id, toolName: "task_update", input }) as ToolCallEvent;
  const rejected = await handlers.get("tool_call")!(call("bad", draft), {}) as { block: boolean; reason: string };
  assert.match(rejected.reason, /planId_invalid.*ASCII/);
  const result = await handlers.get("tool_result")!({ toolCallId: "bad", toolName: "task_update", isError: true, content: [], details: {} }) as { isError: boolean; content: { text: string }[] };
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, rejected.reason, "the sole extension returns the exact correction guidance to the model");
  const corrected = { ...draft, planId: "ohm-plan", steps: [{ ...draft.steps[0], stepId: "step-1" }] };
  assert.equal(await security.handleToolCall(call("fixed", corrected), undefined), undefined);
  const tool = createPiTaskPlanToolDefinition({ sessionManager: manager, security });
  await tool.execute("fixed", corrected as never, undefined, undefined, {} as never);
  await security.handleToolResult({ toolCallId: "fixed", toolName: "task_update" } as never);
  assert.equal(latestTaskPlanFromBranch(manager.getBranch())?.planId, "ohm-plan");

  runId = "bounded-retry";
  assert.ok((await security.handleToolCall(call("bad-1", draft), undefined))?.block);
  assert.match((await security.handleToolCall(call("bad-2", draft), undefined))?.reason ?? "", /停止重试/);
  assert.match((await security.handleToolCall(call("bad-3", corrected), undefined))?.reason ?? "", /single correction attempt/);
  runId = "schema-correction";
  const schemaResult = await security.handleToolResult({ type: "tool_result", toolCallId: "schema-bad", toolName: "task_update",
    input: { planId: "schema-plan" }, content: [{ type: "text", text: 'Validation failed for tool "task_update":\n- title: Required\n\nReceived arguments:\n{"canary":"DO_NOT_ECHO_ARGUMENTS"}' }], isError: true } as never);
  assert.match(schemaResult.content[0].text, /task_plan_arguments_invalid.*retry task_update once/s);
  assert.match(schemaResult.content[0].text, /title: Required/);
  assert.equal(schemaResult.content[0].text.includes("DO_NOT_ECHO_ARGUMENTS"), false);
  assert.equal(await security.handleToolCall(call("schema-fixed", corrected), undefined), undefined);
  console.log("Plan mode settings isolation, migration, frozen mode and task_update correction: PASS");
}
