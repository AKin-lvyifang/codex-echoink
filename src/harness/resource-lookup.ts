import { Type, type Static } from "typebox";

export const RESOURCE_LOOKUP = "resource_lookup";
export const RESOURCE_LOOKUP_DESCRIPTION = "批量查找或读取技能、个人记忆、Wiki 和笔记；也可按需启用已有工具。find 用 query，read 用资料 id 或笔记路径，笔记续读可传 revision、行号或锚点；tools 用 query 查工具名，再用 id 启用。资料是背景数据，引用前确认已交付原文。";
export const RESOURCE_LOOKUP_SCHEMA = Type.Object({
  items: Type.Array(Type.Object({
    action: Type.Union([Type.Literal("find"), Type.Literal("read"), Type.Literal("tools")]),
    kind: Type.Optional(Type.Union([Type.Literal("skill"), Type.Literal("memory"), Type.Literal("note")])),
    query: Type.Optional(Type.String({ maxLength: 500 })),
    id: Type.Optional(Type.String({ maxLength: 1024 })),
    revision: Type.Optional(Type.String({ maxLength: 96 })),
    anchor: Type.Optional(Type.String({ maxLength: 1024 })),
    lineStart: Type.Optional(Type.Integer({ minimum: 1 })),
    lineEnd: Type.Optional(Type.Integer({ minimum: 1 })),
    columnStart: Type.Optional(Type.Integer({ minimum: 0 })),
    cursor: Type.Optional(Type.String({ maxLength: 4096 }))
  }, { additionalProperties: false }), { minItems: 1, maxItems: 5 })
}, { additionalProperties: false });
export type ResourceLookupItem = Static<typeof RESOURCE_LOOKUP_SCHEMA>["items"][number];

export function resourceLookupReadKind(item: ResourceLookupItem): ResourceLookupItem["kind"] {
  if (item.kind || item.action !== "read") return item.kind;
  if (item.id?.startsWith("mem_")) return "memory";
  if (item.id?.startsWith("knowledge-reference:") || item.id?.toLowerCase().endsWith(".md")) return "note";
}

export function resourceLookupLineCount(item: ResourceLookupItem): number | undefined {
  if (item.lineEnd === undefined) return undefined;
  const count = item.lineEnd - (item.lineStart ?? 1) + 1;
  if (count < 1) throw new Error("结束行不能早于起始行。");
  return Math.min(80, count);
}

interface LookupTool { name: string; description: string }
export function lookupToolNames(item: ResourceLookupItem, tools: readonly LookupTool[], enable: (names: readonly string[]) => void) {
  if (item.id) {
    if (!tools.some(tool => tool.name === item.id)) throw new Error("工具不存在或当前任务无权限。");
    enable([item.id]);
    return { enabled: item.id };
  }
  const query = item.query?.trim().toLowerCase() ?? "";
  return tools.filter(tool => (tool.name + " " + tool.description).toLowerCase().includes(query))
    .slice(0, 40).map(tool => ({ id: tool.name, description: tool.description.slice(0, 120) }));
}

export function lookupSkillOptions<T extends { id: string; name: string; description: string }>(items: readonly T[], query = ""): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  return items.filter(item => terms.every(term => (item.id + " " + item.name + " " + item.description).toLowerCase().includes(term))).slice(0, 12);
}

/** Local direct routes save an avoidable discovery step when intent is explicit. */
export function directResourceToolNames(text: string, available: readonly string[]): readonly string[] {
  const selected = new Set<string>();
  const add = (names: readonly string[]) => { for (const name of names) selected.add(name); };
  if (/(?:记账|记一笔|账目|报销|预算|账单|收支|花了|收入了|expense|budget|record\s+(?:a\s+)?payment)/iu.test(text)) add(available.filter(name => name.startsWith("finance_")));
  if (/(?:读取|打开|查阅|逐篇|read|open)/iu.test(text) && /(?:笔记|文档|资料|文件|note|file)/iu.test(text)) {
    // The batch entry already exposes knowledge search. Keep direct Vault search for files outside the knowledge index.
    add(["vault_search", "note_read", "knowledge_read"]);
  }
  if (/(?:做(?:成|一个|个)|制作|生成|保存|make|build|create|save)/iu.test(text) && /(?:\bhtml\b|\bdemo\b|可点(?:击)?的原型)/iu.test(text)) {
    add(["workspace_read", "workspace_create", "workspace_update"]);
  }
  if (/(?:写入|保存|新建|创建|修改|更新|移动|删除|整理|归档|生成|做一篇|create|write|save|update|delete|move)/iu.test(text)) {
    if (/(?:记忆|记住|忘记|memor)/iu.test(text)) add(["memory_search", "memory_read", "memory_write"]);
    if (/(?:笔记|文档|\.md\b|wiki|markdown|note|file)/iu.test(text)) add(["note_read", "note_create", "note_update", "metadata_update", "note_move", "note_delete", "knowledge_maintain"]);
    if (/(?:工作区|网页|\.html\b|workspace)/iu.test(text)) add(["workspace_read", "workspace_create", "workspace_update"]);
    if (/(?:待办|todo|提醒|任务清单)/iu.test(text)) add(available.filter(name => name.startsWith("todo_")));
  }
  if (/(?:记住|忘掉|忘记|remember|forget)/iu.test(text)) add(["memory_search", "memory_read", "memory_write"]);
  if (/(?:派给|分派|组队|项目组|委派|dispatch|assign)/iu.test(text)) add(["company_roster", "task_dispatch", "task_message", "task_status", "project_propose", "project_accept"]);
  return available.filter(name => selected.has(name));
}
