import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { App } from "obsidian";
import { financeConversationPort } from "../lifestyle/finance-conversation-port";
import type { LifestyleFinanceService } from "../lifestyle/finance-service";
import { financeValueVersion } from "../lifestyle/finance-operation-types";
import { PI_FINANCE_TOOL_IDS, normalizeFinanceToolRequest, financeToolEffect, hasDirectFinanceIntent } from "../harness/pi-native/finance-tool-policy";
import type { MobileCapabilityPolicy } from "./capability-policy";
import { newId, type MobileStore } from "./store";
import type { MobileToolExecutionContext, MobileWriteOperation } from "./task-contracts";
import { assertMobileResumeObservations, assertMobileWriteNotReplayed, assertMobileWriteRun } from "./task-recovery";
import { mobileFinanceObservation, type MobileFinanceEvidence } from "./finance-journal";

export function mobileFinanceTools(app: App, finance: LifestyleFinanceService, store: MobileStore, taskId: string, policy: MobileCapabilityPolicy, execution?: MobileToolExecutionContext): AgentTool[] {
  const fields = { action: Type.String(), ...Object.fromEntries(["id", "query", "from", "to", "category", "billPlanId", "scope", "expectedVersion", "name"].map(key => [key, Type.Optional(Type.String())])),
    record: Type.Optional(Type.Unknown()), patch: Type.Optional(Type.Unknown()), targets: Type.Optional(Type.Array(Type.Object({ id: Type.String(), expectedVersion: Type.String() }), { minItems: 1, maxItems: 50 })),
    totalCents: Type.Optional(Type.Integer()), budgetCents: Type.Optional(Type.Integer()), allocations: Type.Optional(Type.Record(Type.String(), Type.Integer())), deltas: Type.Optional(Type.Record(Type.String(), Type.Integer())), limit: Type.Optional(Type.Integer()), offset: Type.Optional(Type.Integer()) };
  const descriptions = [
    "只读查账：action records/catalog/budget/bills/operations。records返回真实id和expectedVersion，limit最多50、offset续读；operations读取当前任务写前意图/回执，未知结果禁止重放。",
    "账目action create/update/delete。create用record，amountCents整数分；update/delete先查询，targets必须含id和expectedVersion。update仅改patch。分类取catalog已有值，明确用户指令才写；失败/未知先查operations，不能重复create。",
    "预算action get/update；scope current/YYYY-MM/default。先get拿expectedVersion，再用totalCents、allocations绝对分或deltas相对分修改；未设额度不得猜测，保留其他字段。",
    "账单action list/create/update/associate。create用name/budgetCents/allocations；update需id/expectedVersion；associate还需精确targets。金额整数分，失败/未知先读operations。"
  ];
  return PI_FINANCE_TOOL_IDS.map((tool, index) => ({ name: tool, label: ["查询财务", "操作账目", "操作预算", "操作账单"][index], description: descriptions[index], parameters: Type.Object(fields),
    execute: async (callId, args: Record<string, unknown>, signal) => {
      const input = normalizeFinanceToolRequest(tool, args), write = financeToolEffect(tool, input) !== "read";
      const allowed = () => { if (signal?.aborted) throw new Error("已停止，未继续财务操作。"); policy.assertTool(tool, input); };
      allowed();
      if (tool === "finance_query" && input.action === "operations") {
        await finance.readForConversation(); allowed();
        return result({ operations: (store.getSession(taskId)?.operations ?? []).filter(item => item.toolName === "finance_write" && (!input.id || item.id === input.id)) });
      }
      if (write && (!execution || !hasDirectFinanceIntent(tool, input, execution.userText ?? ""))) throw new Error("请先明确本次财务写入意图，未执行操作。");
      const guard = () => { allowed(); if (write && execution) { const task = store.getSession(taskId); if (!task) throw new Error("任务不存在。"); assertMobileWriteRun(task, execution); } };
      const prepared = await financeConversationPort(finance, guard)(tool, input, `${taskId}:${execution?.runId ?? "read"}:${callId}`, signal);
      guard();
      if (!write) { const response = await prepared.execute(signal); allowed(); return result(response); }
      const run = execution!;
      const target = `finance:${financeValueVersion(prepared.target)}`, semanticKey = `finance_write:${prepared.effectArgumentsSha256!}`;
      const evidence: MobileFinanceEvidence = { tool, action: input.action, targetVersion: prepared.targetVersion };
      const at = Date.now(), operation: MobileWriteOperation = { id: newId(), taskId, runId: run.runId, toolCallId: callId, toolName: "finance_write", target,
        semanticKey, expectedHash: financeValueVersion(prepared.targetVersion), finance: evidence, status: "prepared", createdAt: at, updatedAt: at };
      await assertMobileResumeObservations(app, store, run.resume, signal, finance);
      await store.updateSession(taskId, task => { guard(); assertMobileWriteNotReplayed(task, run, "finance_write", callId, semanticKey, target); (task.operations ??= []).push(operation); });
      try {
        const response = await prepared.execute(signal, async () => {
          await store.updateSession(taskId, task => { guard(); const saved = task.operations!.find(item => item.id === operation.id)!; if (saved.status !== "prepared") throw new Error("财务写入已有执行记录。"); saved.status = "started"; saved.updatedAt = Date.now(); }); guard();
        });
        guard();
        if (response.status !== "completed" || response.readbackVerified !== true) throw new Error("财务操作尚未完整核实，请先查询operations，禁止重放。");
        const observed = await mobileFinanceObservation(finance, evidence); guard();
        if (!observed.matches || observed.hash === "unreadable") throw new Error("财务保存回读不一致，请先核对当前资料，禁止重放。");
        await store.updateSession(taskId, task => { guard(); const saved = task.operations!.find(item => item.id === operation.id)!; saved.status = "completed"; saved.finance!.observedHash = observed.hash; saved.updatedAt = Date.now(); });
        return result(response);
      } catch (error) {
        try { await store.updateSession(taskId, task => { const saved = task.operations?.find(item => item.id === operation.id); if (saved && saved.status !== "completed") { saved.status = "uncertain"; saved.updatedAt = Date.now(); } }); } catch { /* The last durable intent still blocks replay. */ }
        throw error;
      }
    } }));
}
const result = (details: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });
