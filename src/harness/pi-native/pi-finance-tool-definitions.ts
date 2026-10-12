import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiObsidianToolSecurity } from "./pi-obsidian-tools";
import { PI_FINANCE_TOOL_IDS } from "./finance-tool-policy";

export function createPiFinanceToolDefinitions(security: PiObsidianToolSecurity): ToolDefinition[] {
  const string = Type.String(); const version = Type.String({ pattern: "^[a-f0-9]{64}$" });
  const cents = Type.Integer({ minimum: 1 });
  const allocations = Type.Record(string, Type.Integer({ minimum: 0 }));
  const targets = Type.Array(Type.Object({ id: string, expectedVersion: version }, { additionalProperties: false }), { minItems: 1, maxItems: 50 });
  const record = Type.Object({ amountCents: Type.Optional(cents), date: Type.Optional(string), kind: Type.Optional(Type.Union(["expense", "income", "refund", "transfer"].map(v => Type.Literal(v)))), ...Object.fromEntries(["merchant", "account", "category", "description", "note", "icon"].map(k => [k, Type.Optional(string)])), billPlanId: Type.Optional(Type.Union([string, Type.Null()])) }, { additionalProperties: false });
  const specs: { name: string; label: string; description: string; fields: Parameters<typeof Type.Object>[0] }[] = [
    { name: "finance_query", label: "查询财务", description: "只读查询当前财务账本。action records返回精确id、expectedVersion和实际字段；可按id/query/from/to/category/billPlanId过滤，limit最多50、offset续读。catalog返回全局已有分类/账户及别名；budget读scope current/YYYY-MM/default；bills返回账单id/expectedVersion。operations核对原操作身份和持久回执，结果不确定时先读这里再按原recordId读取。目标多候选先澄清。查询不创建Base、不迁移。", fields: { action: Type.Union(["records", "catalog", "budget", "bills", "operations"].map(v => Type.Literal(v))), ...Object.fromEntries(["id", "query", "from", "to", "category", "billPlanId", "scope"].map(k => [k, Type.Optional(string)])), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) } },
    { name: "finance_record", label: "操作账目", description: "action create用record新增：amountCents整数分必填，省略date用本地今日，kind默认expense；商户/账户未指定留空，无需追问、不伪造。早餐12元用餐饮、说明早餐、1200分。分类使用catalog已有启用名称。update/delete必须用查询所得targets [{id,expectedVersion}]；update只改patch指定字段，delete可恢复。明确单笔指令直接执行；批量对象/影响不清先澄清。失败或uncertain先只读核对原操作，不再create。", fields: { action: Type.Union(["create", "update", "delete"].map(v => Type.Literal(v))), record: Type.Optional(record), patch: Type.Optional(record), targets: Type.Optional(targets) } },
    { name: "finance_budget", label: "操作预算", description: "action get/update，scope current或YYYY-MM只改指定月；default只用于以后每个月。update先get读取expectedVersion；totalCents只在用户明确改总额时传。allocations指定分类绝对金额，deltas指定相对增减整数分，未设额度不能猜原值。保留总额及其他分类；超额返回失败不保存，需用户选择处理。返回before/after和实际未分配变化。", fields: { action: Type.Union([Type.Literal("get"), Type.Literal("update")]), scope: Type.Optional(string), expectedVersion: Type.Optional(version), totalCents: Type.Optional(cents), allocations: Type.Optional(allocations), deltas: Type.Optional(Type.Record(string, Type.Integer())) } },
    { name: "finance_bill", label: "操作账单", description: "action list/create/update/associate。create用name、budgetCents，可只给总额，allocations可选且用已有分类；update必须id、expectedVersion，保留未指定字段，不存在不能新增。associate必须唯一账单id/expectedVersion与精确records targets，刚才一笔从上轮工具回执定位，多个候选先澄清，不关联其他历史。金额都是整数分；超出总额不保存。", fields: { action: Type.Union(["list", "create", "update", "associate"].map(v => Type.Literal(v))), id: Type.Optional(string), expectedVersion: Type.Optional(version), name: Type.Optional(string), budgetCents: Type.Optional(cents), allocations: Type.Optional(allocations), targets: Type.Optional(targets) } }
  ];
  return specs.map((spec, i) => defineTool({ name: spec.name, label: spec.label, description: spec.description, parameters: Type.Object(spec.fields, { additionalProperties: false }), execute: async (id, args, signal) => {
    await security.execute(id, PI_FINANCE_TOOL_IDS[i], args, signal);
    return { content: [{ type: "text" as const, text: "finance_result_pending_safety" }], details: {} };
  } }));
}
