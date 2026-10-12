import type { FinanceRecordPatch, FinanceBudgetPatch } from "../../lifestyle/finance-operation-types";

export const PI_FINANCE_TOOL_IDS = ["finance_query", "finance_record", "finance_budget", "finance_bill"] as const;
export type PiFinanceToolId = typeof PI_FINANCE_TOOL_IDS[number];
export interface FinanceTarget { id: string; expectedVersion: string }
export type FinanceToolRequest = {
  action: string; id?: string; query?: string; from?: string; to?: string; category?: string; billPlanId?: string;
  scope?: string; limit?: number; offset?: number; expectedVersion?: string; targets?: FinanceTarget[];
  record?: FinanceRecordPatch; patch?: FinanceRecordPatch; totalCents?: number; allocations?: Record<string, number>;
  deltas?: Record<string, number>; name?: string; budgetCents?: number;
};
const actions: Record<PiFinanceToolId, readonly string[]> = {
  finance_query: ["records", "catalog", "budget", "bills", "operations"], finance_record: ["create", "update", "delete"],
  finance_budget: ["get", "update"], finance_bill: ["list", "create", "update", "associate"]
};
export function isFinanceTool(tool: string): tool is PiFinanceToolId { return PI_FINANCE_TOOL_IDS.some(t => t === tool); }
export function financeToolEffect(tool: PiFinanceToolId, input: FinanceToolRequest): "read" | "note_write" {
  return tool === "finance_query" || tool === "finance_budget" && input.action === "get" || tool === "finance_bill" && input.action === "list" ? "read" : "note_write";
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("finance_invalid_request");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error("finance_invalid_request");
}
function amountMap(value: unknown, deltas = false): Record<string, number> {
  const v = object(value);
  for (const [name, cents] of Object.entries(v)) if (!name.trim() || name.length > 60 || !Number.isSafeInteger(cents) || !deltas && Number(cents) < 0) throw new Error("finance_invalid_amount");
  return { ...v } as Record<string, number>;
}
function recordPatch(value: unknown): FinanceRecordPatch {
  const v = object(value);
  fields(v, ["date", "merchant", "amountCents", "kind", "category", "account", "description", "note", "icon", "billPlanId"]);
  for (const [key, val] of Object.entries(v)) {
    if (key === "billPlanId" && val === null) continue;
    if (key === "amountCents") { if (!Number.isSafeInteger(val) || Number(val) <= 0) throw new Error("finance_invalid_amount"); }
    else if (typeof val !== "string" || val.length > (key === "merchant" ? 60 : 1000) || /\0/u.test(val)) throw new Error("finance_invalid_record");
  }
  if (v.kind !== undefined && !["expense", "income", "refund", "transfer"].includes(String(v.kind))) throw new Error("finance_invalid_record");
  if (v.date !== undefined) {
    const text = String(v.date); const date = new Date(text.slice(0, 10) + "T12:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/u.test(text) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text.slice(0, 10)) throw new Error("finance_invalid_date");
  }
  return { ...v } as FinanceRecordPatch;
}
export function normalizeFinanceToolRequest(tool: PiFinanceToolId, value: unknown): FinanceToolRequest {
  const v = object(value); const action = String(v.action);
  if (!actions[tool].includes(action)) throw new Error("finance_invalid_action");
  const allowed = tool === "finance_query" ? ["action", "id", "query", "from", "to", "category", "billPlanId", "scope", "limit", "offset"]
    : tool === "finance_record" ? ["action", "record", "targets", "patch"]
      : tool === "finance_budget" ? ["action", "scope", "expectedVersion", "totalCents", "allocations", "deltas"]
        : ["action", "id", "name", "budgetCents", "allocations", "expectedVersion", "targets"];
  fields(v, allowed);
  const result = { ...v, action } as FinanceToolRequest;
  for (const key of ["id", "query", "from", "to", "category", "billPlanId", "scope", "expectedVersion", "name"]) if (v[key] !== undefined && (typeof v[key] !== "string" || !v[key].trim() || v[key].length > 500 || /\0/u.test(v[key]))) throw new Error("finance_invalid_request");
  for (const key of ["totalCents", "budgetCents"]) if (v[key] !== undefined && (!Number.isSafeInteger(v[key]) || Number(v[key]) <= 0)) throw new Error("finance_invalid_amount");
  if (v.limit !== undefined && (!Number.isSafeInteger(v.limit) || Number(v.limit) < 1 || Number(v.limit) > 50)) throw new Error("finance_invalid_request");
  if (v.offset !== undefined && (!Number.isSafeInteger(v.offset) || Number(v.offset) < 0)) throw new Error("finance_invalid_request");
  if (v.allocations !== undefined) result.allocations = amountMap(v.allocations);
  if (v.deltas !== undefined) result.deltas = amountMap(v.deltas, true);
  if (v.record !== undefined) result.record = recordPatch(v.record);
  if (v.patch !== undefined) result.patch = recordPatch(v.patch);
  if (v.targets !== undefined) {
    if (!Array.isArray(v.targets) || !v.targets.length || v.targets.length > 50) throw new Error("finance_targets_required");
    result.targets = v.targets.map(t => {
      const target = object(t); fields(target, ["id", "expectedVersion"]);
      if (typeof target.id !== "string" || !target.id.trim() || typeof target.expectedVersion !== "string" || !/^[a-f0-9]{64}$/u.test(target.expectedVersion)) throw new Error("finance_targets_required");
      return { id: target.id, expectedVersion: target.expectedVersion };
    });
    if (new Set(result.targets.map(t => t.id)).size !== result.targets.length) throw new Error("finance_duplicate_target");
  }
  if (tool === "finance_record") {
    if (action === "create" && (!result.record?.amountCents || v.targets || v.patch)) throw new Error("finance_record_amount_required");
    if (action !== "create" && (!result.targets || v.record || action === "update" && (!result.patch || !Object.keys(result.patch).length) || action === "delete" && v.patch)) throw new Error("finance_targets_required");
  }
  if (tool === "finance_budget" && action === "update" && (!result.expectedVersion || !["totalCents", "allocations", "deltas"].some(k => v[k] !== undefined))) throw new Error("finance_version_required");
  if (tool === "finance_bill") {
    if (action === "create" && (!result.name || !result.budgetCents || v.id || v.targets || v.expectedVersion)) throw new Error("finance_bill_fields_required");
    if (action === "update" && (!result.id || !result.expectedVersion || !["name", "budgetCents", "allocations"].some(k => v[k] !== undefined))) throw new Error("finance_version_required");
    if (action === "associate" && (!result.id || !result.expectedVersion || !result.targets || v.name || v.budgetCents || v.allocations)) throw new Error("finance_targets_required");
  }
  return result;
}
export function budgetPatch(request: FinanceToolRequest): FinanceBudgetPatch {
  return { ...(request.totalCents !== undefined ? { totalCents: request.totalCents } : {}), ...(request.allocations ? { allocations: request.allocations } : {}), ...(request.deltas ? { deltas: request.deltas } : {}) };
}

/** Only the frozen human message can supply intent; tool arguments cannot. */
export function hasDirectFinanceIntent(tool: PiFinanceToolId, request: FinanceToolRequest, userText: string): boolean {
  const text = userText.trim();
  if (!text || /不(?:用|要|必|允许|写入|执行)|无需|别(?:写|记|改|删)|先(?:讨论|看看|分析)|示例|假设|如何|怎么|能否|是否|教我|如果|查询|查一下|查看|请问|多少钱|多少[？?]|他说|朋友说|引用|do not|don't|how (?:to|do)|example|hypothetical/iu.test(text)) return false;
  if ((request.targets?.length ?? 0) > 1 && !/全部|所有|这(?:些|几)笔|(?:本|这个|上个|指定)月|从.+到|\d{4}-\d{2}/u.test(text)) return false;
  if (tool === "finance_record") return request.action === "create" ? /^(?:(?:请|麻烦|帮我|帮忙|再|也|给我)\s*)*(?:记(?:一下|一笔|账|下|下来)|记录|record|log|add)/iu.test(text)
    || /(?:把|将).{1,80}(?:记(?:一下|下来|一笔)|记录下来)/u.test(text) || /[，,。]\s*(?:请|帮我)?记(?:一下|一笔|下来)/u.test(text)
    : request.action === "delete" ? /删除|删掉|移除|delete|remove/iu.test(text) : /修改|改成|改为|改到|改一下|调整|整理|归类|update|change|categorize/iu.test(text);
  if (tool === "finance_budget") return /预算|budget/iu.test(text) && /调整|改|提高|增加|减少|降低|设|change|set|increase|reduce/iu.test(text);
  return request.action === "associate" ? /记到|放到|关联|归入|关联到|link|associate/iu.test(text)
    : /账单|旅行|bill|trip/iu.test(text) && (request.action === "create" ? /建|创建|新增|create|add/iu.test(text) : /改|调整|update|change/iu.test(text));
}
