import type { TFile, App, EventRef } from "obsidian";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { classifyKnowledgePath } from "../knowledge-base/folder-bindings";
import { knowledgeRolePath, knowledgeRootRole } from "../knowledge-base/root-paths-core";
import { completeKnowledgeMaintenanceCandidateSources, validateKnowledgeMaintenanceCandidateSources, type KnowledgeMaintenanceSourcesHost } from "../knowledge-base/knowledge-maintenance-sources-core";
import { sha256Hex } from "../utils/sha256";
import type { MobileCapabilityPolicy } from "./capability-policy";
import type { MobileStore } from "./store";
import { newId } from "./store";
import type { MobileToolExecutionContext, MobileWriteOperation } from "./task-contracts";
import type { LifestyleFinanceService } from "../lifestyle/finance-service";
import { normalizeMobileNoteTarget, assertMobileWriteRun, assertMobileWriteNotReplayed, assertMobileResumeObservations, mobileNoteUpdateKey } from "./task-recovery";

const isFile = (value: unknown): value is TFile => !!value && typeof value === "object" && "extension" in value && typeof value.extension === "string";
const fail = (message: string): never => { throw new Error(message); };
function normalized(value: string): string {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) return "../" + value; parts.pop(); } else parts.push(part);
  }
  return parts.join("/") || ".";
}
export function mobileKnowledgeSourcesHost(bindings: KnowledgeFolderBindings | null | undefined): KnowledgeMaintenanceSourcesHost {
  return {
    normalizePath(value) {
      if (!value || value !== value.trim() || value.startsWith("/") || /[\\:\p{Cc}]/u.test(value) || value.split("/").some(part => !part || part.startsWith("."))) return fail("资料来源路径无效。");
      return value;
    }, rolePath: value => knowledgeRolePath(value, bindings),
    path: { normalize: normalized, join: (...values) => normalized(values.filter(Boolean).join("/")), dirname: value => value.includes("/") ? value.slice(0, value.lastIndexOf("/")) : "." }
  };
}
function assertEditors(app: App, path: string, expected: string, accepted?: string): void {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view as unknown as { file?: { path: string }; editor?: { getValue(): string }; getMode?(): string };
    if (view.file?.path !== path || !view.editor || view.getMode?.() === "preview") continue;
    const current = view.editor.getValue();
    if (current !== expected && current !== accepted) fail("原文还有未保存或刚刚输入的修改，已保留；请保存后重新读取。");
  }
}
const markers = (value: string): string => (value.match(/<!--\s*echoink-source[^\n]*?-->/gu) ?? []).join("\n");
/** Existing Markdown only; final permission and byte comparisons run inside Vault.process. */
export function mobileNoteUpdateTool(app: App, store: MobileStore, taskId: string, policy: MobileCapabilityPolicy,
  execution: MobileToolExecutionContext | undefined, bindings: () => KnowledgeFolderBindings | null | undefined,
  finance?: LifestyleFinanceService): AgentTool {
  return { name: "note_update", label: "更新笔记", description: "精确更新已有Markdown。先note_read读完整原文，原样传expectedContentRevision和完整content，不可覆写后来修改。原始资料正文不能改；补来源时传sourcePaths，程序锁真实Raw并补可点击链接和机器版本，不能编来源标记。失败/中断先核对，禁止重放旧写入。", parameters: Type.Object({ path: Type.String(), expectedContentRevision: Type.String(), content: Type.String(), sourcePaths: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 20 })) }),
    execute: async (callId, args: { path: string; expectedContentRevision: string; content: string; sourcePaths?: string[] }, signal) => {
      const path = normalizeMobileNoteTarget(args.path), expectedBefore = /^sha256:([a-f0-9]{64})$/u.exec(args.expectedContentRevision)?.[1];
      if (!expectedBefore || typeof args.content !== "string" || new TextEncoder().encode(args.content).length > 1024 * 1024) return fail("请重新读取完整原文并使用其版本；笔记不能超过 1 MiB。");
      if (!execution) return fail("此更新必须由有持久写入记录的任务发起。");
      const roleAt = (value: string) => { const current = bindings(); return current ? classifyKnowledgePath(current, value) : knowledgeRootRole(value); };
      const guard = () => {
        if (signal?.aborted) fail("已停止，未继续改写。");
        policy.assertTool("note_update", args, path);
        if (roleAt(path) === "raw") fail("此操作不能改写原始资料正文。");
        const task = store.getSession(taskId); if (!task) fail("任务不存在。"); assertMobileWriteRun(task!, execution);
      };
      guard();
      const file = app.vault.getAbstractFileByPath(path); if (!isFile(file)) return fail("原笔记不存在，请重新读取。");
      const before = await app.vault.read(file); guard();
      if (sha256Hex(before) !== expectedBefore) return fail("原文已变化，未覆盖；请重新读取后再决定。");
      assertEditors(app, path, before);
      const sourcePaths = new Set(args.sourcePaths ?? []), refs: EventRef[] = [];
      let sourceChanged = false;
      const changed = (file: { path: string }, oldPath?: string) => { if (sourcePaths.has(file.path) || oldPath && sourcePaths.has(oldPath)) sourceChanged = true; };
      refs.push(app.vault.on("modify", changed), app.vault.on("delete", changed), app.vault.on("rename", changed));
      const sources: { relativePath: string; contentSha256: string; file: TFile; content: string; mtime: number; size: number }[] = [];
      const sourceGuard = () => {
        guard(); if (sourceChanged) fail("资料来源已变化，未继续发布旧候选。");
        for (const source of sources) {
          policy.assertReadPath(source.relativePath);
          if (roleAt(source.relativePath) !== "raw" || source.file.path !== source.relativePath || source.file.stat.mtime !== source.mtime || source.file.stat.size !== source.size) fail("资料来源或目录权限已变化，请重新读取。");
          assertEditors(app, source.relativePath, source.content);
        }
      };
      const verifySources = async () => {
        for (const source of sources) {
          sourceGuard(); const current = await app.vault.read(source.file); sourceGuard();
          if (sha256Hex(current) !== source.contentSha256) fail("资料来源内容已变化，请重新核对。");
        }
      };
      let operation: MobileWriteOperation | undefined;
      try {
        for (const raw of sourcePaths) {
          policy.assertReadPath(raw); if (roleAt(raw) !== "raw") fail("资料来源必须是当前已启用的资料目录。");
          const source = app.vault.getAbstractFileByPath(raw); if (!isFile(source) || !/\.(?:md|markdown|txt)$/iu.test(raw)) return fail("资料来源不可直接读取，请先在电脑处理文档。");
          const content = await app.vault.read(source); guard();
          sources.push({ relativePath: raw, contentSha256: sha256Hex(content), content, file: source, mtime: source.stat.mtime, size: source.stat.size }); sourceGuard();
        }
        let content = args.content, evidence: readonly unknown[] = [];
        if (sources.length) {
          const role = roleAt(path); if (role !== "wiki" && role !== "projects") fail("来源修复只用于已绑定的知识成果或项目笔记。");
          const host = mobileKnowledgeSourcesHost(bindings());
          content = completeKnowledgeMaintenanceCandidateSources({ targetPath: path, content, selectedSources: sources }, host);
          evidence = validateKnowledgeMaintenanceCandidateSources({ targetPath: path, content, selectedSources: sources }, host);
        } else if (markers(content) !== markers(before) || /echoink-source/iu.test(content.replace(/<!--\s*echoink-source[^\n]*?-->/gu, ""))) fail("不能自行改写来源标记；请指定真实资料来源后再更新。");
        sourceGuard(); const afterHash = sha256Hex(content), semanticKey = mobileNoteUpdateKey(path, expectedBefore, sha256Hex(args.content)), at = Date.now();
        await assertMobileResumeObservations(app, store, execution.resume, signal, finance); sourceGuard();
        operation = { id: newId(), taskId, runId: execution.runId, toolCallId: callId, toolName: "note_update", target: path, semanticKey, beforeHash: expectedBefore, requestedHash: sha256Hex(args.content), expectedHash: afterHash, status: "prepared", createdAt: at, updatedAt: at };
        const savedOperation = operation;
        await store.updateSession(taskId, task => { sourceGuard(); assertMobileWriteNotReplayed(task, execution, "note_update", callId, semanticKey, path); (task.operations ??= []).push(savedOperation); });
        await verifySources();
        sourceGuard();
        await store.updateSession(taskId, task => { sourceGuard(); const current = task.operations?.find(item => item.id === savedOperation.id); if (!current || current.status !== "prepared") fail("改写意图已变化。"); current!.status = "started"; current!.updatedAt = Date.now(); });
        sourceGuard();
        if (before !== content) await app.vault.process(file, current => { sourceGuard(); if (file.path !== path || sha256Hex(current) !== expectedBefore) return fail("保存时原文已变化，原内容未覆盖。"); assertEditors(app, path, before); return content; });
        sourceGuard();
        if (file.path !== path || sha256Hex(await app.vault.read(file)) !== afterHash) fail("改写回读尚未核实，请先核对现状，不要重放。");
        await verifySources(); sourceGuard(); assertEditors(app, path, before, content);
        await store.updateSession(taskId, task => { sourceGuard(); const current = task.operations?.find(item => item.id === savedOperation.id); if (!current || current.status !== "started") fail("改写回执已变化。"); current!.status = "completed"; current!.updatedAt = Date.now(); });
        for (const observed of execution.resume?.observations ?? []) if (observed.target === `note_create:${path}` || observed.target === `note_update:${path}`) observed.version = `sha256:${afterHash}`;
        const details = { path, beforeHash: expectedBefore, afterHash, changed: before !== content, readbackVerified: true, sourceEvidence: evidence };
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      } catch (error) {
        if (operation) { const id = operation.id; try { await store.updateSession(taskId, task => { const current = task.operations?.find(item => item.id === id); if (current && current.status !== "completed") { current.status = "uncertain"; current.updatedAt = Date.now(); } }); } catch { /* The durable intent still blocks old writes. */ } }
        throw error;
      } finally { refs.forEach(ref => app.vault.offref(ref)); }
    } };
}
