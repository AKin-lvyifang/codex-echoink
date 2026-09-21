import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { App, TFile } from "obsidian";
import { Type } from "typebox";
import { PERSONAL_MEMORY_SCHEMA, type PersonalMemoryKind, type PersonalMemoryRecord } from "../harness/memory/personal-memory-contracts";
import { MobileStore, newId } from "./store";

export const memoryCategories = [
  { id: "all", label: "全部", kinds: [] },
  { id: "facts", label: "事实", kinds: ["fact"] },
  { id: "views", label: "观点", kinds: ["view"] },
  { id: "decisions", label: "决定", kinds: ["decision"] },
  { id: "active", label: "进行中", kinds: ["goal", "task", "open_loop"] },
  { id: "episodes", label: "经历", kinds: ["episode"] }
] as const;
export function checkedNotePath(value: string): string {
  const path = value.trim();
  if (!path || path.startsWith("/") || /[\\:]/u.test(path) || Array.from(path).some(character => character.charCodeAt(0) < 32) || path.split("/").some(p => !p || p.startsWith(".")) || !path.toLowerCase().endsWith(".md")) {
    throw new Error("请使用当前笔记库内的 Markdown 相对路径，例如：笔记/想法.md。");
  }
  return path;
}
export function searchMemories(records: readonly PersonalMemoryRecord[], query: string, limit = 20): PersonalMemoryRecord[] {
  const text = query.trim().toLocaleLowerCase();
  const terms: readonly string[] = text.match(/[a-z0-9]+|[\u3400-\u9fff]{1,}/gu) ?? [];
  const fragments = terms.flatMap(t => /[\u3400-\u9fff]/u.test(t) && t.length > 2 ? [t, ...Array.from({ length: t.length - 1 }, (_, i) => t.slice(i, i + 2))] : [t]);
  return records.filter(r => r.status === "current").map(record => {
    const haystack = `${record.title}\n${record.content}\n${record.recallWhen}`.toLocaleLowerCase();
    return { record, score: text ? fragments.reduce((s, term) => s + (haystack.includes(term) ? term.length : 0), 0) : 1 };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(r => r.record);
}
function checkStopped(signal?: AbortSignal) { if (signal?.aborted) throw new Error("已停止，未开始此操作。"); }
const result = (details: unknown) => ({ content: [{ type: "text" as const, text: typeof details === "string" ? details : JSON.stringify(details) }], details });
export function mobileTools(app: App, store: MobileStore, selectedNote: () => string): AgentTool[] {
  const tools: AgentTool[] = [
    {
      name: "vault_search", label: "查找笔记", description: "按标题或路径查找当前笔记库的 Markdown 笔记。", parameters: Type.Object({ query: Type.String() }),
      async execute(_id, args: { query: string }, signal) {
        checkStopped(signal);
        const query = String(args.query).toLocaleLowerCase();
        return result(app.vault.getMarkdownFiles().filter(f => !f.path.split("/").some(p => p.startsWith(".")) && f.path.toLocaleLowerCase().includes(query)).slice(0, 50).map(f => ({ path: f.path, title: f.basename })));
      }
    },
    {
      name: "note_read", label: "读取笔记", description: "读取当前/选定笔记或搜索得到的笔记。省略 path 时读取用户引用的笔记。", parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      async execute(_id, args: { path?: string }, signal) {
        checkStopped(signal);
        const path = checkedNotePath(args.path || selectedNote());
        const file = app.vault.getAbstractFileByPath(path);
        if (!file || !("extension" in file)) throw new Error("笔记不存在。");
        const content = await app.vault.read(file as TFile);
        checkStopped(signal);
        return result({ path, content });
      }
    },
    {
      name: "note_create", label: "保存文档", description: "在当前笔记库新建 Markdown。不能覆盖已有文件。只读权限禁止写入。", parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute(_id, args: { path: string; content: string }, signal) {
        const writable = () => { checkStopped(signal); if (store.state.permission === "read-only") throw new Error("当前为只读权限，未写入笔记。"); };
        writable();
        const path = checkedNotePath(args.path);
        if (app.vault.getAbstractFileByPath(path) || await app.vault.adapter.exists(path)) throw new Error("同名文件已存在，请改用新文件名；原文件未被覆盖。");
        const parts = path.split("/").slice(0, -1);
        let directory = "";
        for (const part of parts) {
          writable(); directory = directory ? `${directory}/${part}` : part;
          if (!app.vault.getAbstractFileByPath(directory)) await app.vault.createFolder(directory);
        }
        writable();
        const file = await app.vault.create(path, args.content);
        return result({ path: file.path, saved: true });
      }
    }
  ];
  if (store.state.memoryEnabled) {
    const enabled = (signal?: AbortSignal) => { checkStopped(signal); if (!store.state.memoryEnabled) throw new Error("长期记忆已关闭。"); };
    tools.push({
      name: "memory_search", label: "查找记忆", description: "检索用户记忆；query 为空时列出最近记忆。涉及用户经历、观点、决定或目标时先检索。", parameters: Type.Object({ query: Type.String() }),
      async execute(_id, args: { query: string }, signal) { enabled(signal); return result(searchMemories(store.state.memories, args.query).map(r => ({ id: r.id, kind: r.kind, title: r.title, content: r.content, basis: r.basis, recallWhen: r.recallWhen }))); }
    }, {
      name: "memory_read", label: "读取记忆", description: "读取指定记忆的完整内容和来源。", parameters: Type.Object({ id: Type.String() }),
      async execute(_id, args: { id: string }, signal) { enabled(signal); const record = store.state.memories.find(r => r.id === args.id); if (!record) throw new Error("记忆不存在。"); return result(record); }
    }, {
      name: "memory_write", label: "保存记忆", description: "忠实保存用户明确陈述或当前对话中可观察的长期信息。禁止把引用、文档知识、假设、工具输出或模型猜测写成用户事实。先搜索避免重复；修正旧记忆时提供 targetId。不能删除记忆。", parameters: Type.Object({
        kind: Type.Union(["fact", "view", "decision", "goal", "task", "open_loop", "episode"].map(k => Type.Literal(k))), title: Type.String({ minLength: 1 }), content: Type.String({ minLength: 1 }), recallWhen: Type.String(), basis: Type.Union([Type.Literal("explicit"), Type.Literal("observed")]), targetId: Type.Optional(Type.String())
      }),
      async execute(toolCallId, args: { targetId?: string; kind: PersonalMemoryKind; content: string; title: string; recallWhen: string; basis: "explicit" | "observed" }, signal) {
        enabled(signal);
        const old = args.targetId ? store.state.memories.find(r => r.id === args.targetId) : undefined;
        if (args.targetId && !old) throw new Error("要修正的记忆不存在。");
        const duplicate = store.state.memories.find(r => r.content === args.content && r.kind === args.kind && r.status === "current");
        if (duplicate) return result(duplicate);
        const record: PersonalMemoryRecord = { schema: PERSONAL_MEMORY_SCHEMA, id: old?.id ?? newId(), kind: args.kind, status: "current", date: new Date().toISOString(), source: `mobile:${store.session.id}:${toolCallId}`, basis: args.basis, contentOrigin: args.basis === "explicit" ? "user_statement" : "current_instruction", title: args.title, content: args.content, recallWhen: args.recallWhen, revision: (old?.revision ?? 0) + 1, file: "mobile/state.json" };
        store.state.memories = [record, ...store.state.memories.filter(r => r.id !== record.id)];
        await store.save();
        return result(record);
      }
    });
  }
  return tools;
}
