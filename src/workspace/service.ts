import type { App, DataAdapter, TFile } from "obsidian";
import { sha256Hex } from "../utils/sha256";

export const WORKSPACE_ROOT = "EchoInk/工作区";
export const WORKSPACE_MAX_BYTES = 1024 * 1024;
export type WorkspaceOperation = "read" | "create" | "update";
export type WorkspaceGuard = (operation: WorkspaceOperation, path: string) => void;
export type WorkspacePathGuard = (path: string, guard: () => void) => Promise<void>;

export class WorkspaceError extends Error {
  constructor(readonly code: "unsafe_path" | "unsupported_file" | "not_found" | "already_exists" | "source_changed" | "too_large" | "stopped" | "unsafe_adapter", message: string) {
    super(message); this.name = "WorkspaceError";
  }
}
export interface WorkspaceFile {
  path: string;
  contentRevision: string;
  previewPath?: string;
}
export interface WorkspaceReadResult extends WorkspaceFile { content: string }
export interface WorkspaceFilePort {
  adapter: Pick<DataAdapter, "stat" | "list" | "read" | "mkdir">;
  create(path: string, content: string, guard: () => void): Promise<void>;
  process(path: string, change: (current: string) => string): Promise<string>;
  /** Desktop must supply canonical path/lstat validation. Mobile uses the native adapter. */
  assertSafePath?: WorkspacePathGuard;
  requiresPathGuard?: boolean;
  assertUnchangedEditor?(path: string, expected: string): void;
}
export interface WorkspaceServiceOptions {
  guard?: WorkspaceGuard;
  assertSafePath?: WorkspacePathGuard;
}

/** Public tools accept a workspace-relative path or its exact Vault-relative path. */
export function workspacePath(value: string): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 512
    || /[\\:\p{Cc}?#%]/u.test(value) || value.startsWith("/")) throw unsafePath();
  const parts = value.split("/");
  if (parts.some(part => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(" "))) throw unsafePath();
  const path = value.startsWith(`${WORKSPACE_ROOT}/`) ? value : `${WORKSPACE_ROOT}/${value}`;
  if (!/\.(?:html|css|js|md)$/iu.test(path)) throw new WorkspaceError("unsupported_file", "工作区只支持 HTML、CSS、JS 和 MD 文本文件。");
  return path;
}

/** Resolve dependency paths without silently allowing a traversal out of the root. */
export function workspaceDependencyPath(from: string, reference: string): string {
  const source = workspacePath(from);
  if (!reference || reference !== reference.trim() || /[\\:\p{Cc}?#%]/u.test(reference) || reference.startsWith("/")) throw unsafePath();
  const parts = source.slice(WORKSPACE_ROOT.length + 1).split("/"); parts.pop();
  for (const segment of reference.split("/")) {
    if (segment === ".") continue;
    if (segment === "..") { if (!parts.length) throw unsafePath(); parts.pop(); }
    else { if (!segment || segment.startsWith(".")) throw unsafePath(); parts.push(segment); }
  }
  return workspacePath(parts.join("/"));
}

export function workspaceRevision(content: string): string { return `sha256:${sha256Hex(content)}`; }
function unsafePath(): WorkspaceError { return new WorkspaceError("unsafe_path", "路径必须位于 EchoInk/工作区，不能访问隐藏目录、配置或库外文件。"); }
function checkContent(content: string): void {
  if (typeof content !== "string" || content.includes("\0")) throw new WorkspaceError("unsupported_file", "工作区只支持纯文本内容。");
  if (new TextEncoder().encode(content).length > WORKSPACE_MAX_BYTES) throw new WorkspaceError("too_large", "单个工作区文件不能超过 1 MiB。");
}
function fileResult(path: string, content: string): WorkspaceFile {
  return { path, contentRevision: workspaceRevision(content), ...(/\.html$/iu.test(path) ? { previewPath: path } : {}) };
}
function conflict(): WorkspaceError { return new WorkspaceError("source_changed", "文件已变化，未覆盖；请重新读取后再修改。"); }

/** Browser-safe shared service: no Node, shell, local server, or Pi file tools. */
export class WorkspaceService {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly files: WorkspaceFilePort, private readonly options: WorkspaceServiceOptions = {}) {}

  private check(operation: WorkspaceOperation, path: string, guard?: WorkspaceGuard, signal?: AbortSignal): () => void {
    return () => {
      if (signal?.aborted) throw new WorkspaceError("stopped", "已停止，未继续工作区操作。");
      this.options.guard?.(operation, path); guard?.(operation, path);
    };
  }
  private async boundary<T>(action: () => Promise<T>, guard: () => void): Promise<T> {
    guard(); const result = await action(); guard(); return result;
  }
  private async safe(path: string, guard: () => void): Promise<void> {
    guard();
    if (this.files.requiresPathGuard && !this.files.assertSafePath && !this.options.assertSafePath)
      throw new WorkspaceError("unsafe_adapter", "当前文件适配器缺少安全路径校验，未访问工作区。");
    const checker = this.options.assertSafePath ?? this.files.assertSafePath;
    if (checker) await this.boundary(() => checker(path, guard), guard);
    // Validate every existing ancestor through the native adapter as well.
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index++) {
      const current = parts.slice(0, index + 1).join("/");
      const stat = await this.boundary(() => this.files.adapter.stat(current), guard);
      if (!stat) break;
      const extended = stat as { type: string; isSymbolicLink?: boolean | (() => boolean) };
      if (extended.type === "symlink" || (typeof extended.isSymbolicLink === "function" ? extended.isSymbolicLink() : extended.isSymbolicLink)) throw unsafePath();
      if (index < parts.length - 1 && stat.type !== "folder") throw unsafePath();
      if (index === parts.length - 1 && stat.type !== "file") throw unsafePath();
    }
    guard();
  }
  private async serial<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation); this.queues.set(path, next);
    try { return await next; } finally { if (this.queues.get(path) === next) this.queues.delete(path); }
  }
  async read(input: { path: string }, guard?: WorkspaceGuard, signal?: AbortSignal): Promise<WorkspaceReadResult> {
    const path = workspacePath(input.path), check = this.check("read", path, guard, signal);
    await this.safe(path, check);
    const stat = await this.boundary(() => this.files.adapter.stat(path), check);
    if (!stat) throw new WorkspaceError("not_found", "工作区文件不存在。");
    if (stat.size > WORKSPACE_MAX_BYTES) throw new WorkspaceError("too_large", "单个工作区文件不能超过 1 MiB。");
    await this.safe(path, check);
    const content = await this.boundary(() => this.files.adapter.read(path), check);
    await this.safe(path, check); checkContent(content);
    return { ...fileResult(path, content), content };
  }
  async create(input: { path: string; content: string }, guard?: WorkspaceGuard, signal?: AbortSignal): Promise<WorkspaceFile> {
    const path = workspacePath(input.path); checkContent(input.content);
    const check = this.check("create", path, guard, signal);
    return this.serial(path, async () => {
      await this.safe(path, check);
      if (await this.boundary(() => this.files.adapter.stat(path), check)) throw new WorkspaceError("already_exists", "同名工作区文件已存在，原文件未被覆盖。");
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index++) {
        const directory = parts.slice(0, index).join("/");
        await this.safe(path, check);
        if (!await this.boundary(() => this.files.adapter.stat(directory), check)) {
          try { await this.boundary(() => this.files.adapter.mkdir(directory), check); }
          catch (error) { check(); if ((await this.boundary(() => this.files.adapter.stat(directory), check))?.type !== "folder") throw error; }
        }
      }
      await this.safe(path, check);
      if (await this.boundary(() => this.files.adapter.stat(path), check)) throw new WorkspaceError("already_exists", "同名工作区文件已存在，原文件未被覆盖。");
      await this.boundary(() => this.files.create(path, input.content, check), check);
      await this.safe(path, check);
      const saved = await this.boundary(() => this.files.adapter.read(path), check);
      if (saved !== input.content) throw conflict();
      return fileResult(path, saved);
    });
  }
  async update(input: { path: string; content: string; expectedRevision: string }, guard?: WorkspaceGuard, signal?: AbortSignal): Promise<WorkspaceFile> {
    const path = workspacePath(input.path); checkContent(input.content);
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.expectedRevision)) throw conflict();
    const check = this.check("update", path, guard, signal);
    return this.serial(path, async () => {
      const current = await this.read({ path }, (_operation, target) => { check(); guard?.("update", target); }, signal);
      check(); if (current.contentRevision !== input.expectedRevision) throw conflict();
      this.files.assertUnchangedEditor?.(path, current.content);
      await this.safe(path, check);
      await this.boundary(() => this.files.process(path, latest => {
        check(); if (workspaceRevision(latest) !== input.expectedRevision) throw conflict();
        this.files.assertUnchangedEditor?.(path, latest);
        return input.content;
      }), check);
      await this.safe(path, check);
      const saved = await this.boundary(() => this.files.adapter.read(path), check);
      if (saved !== input.content) throw conflict();
      return fileResult(path, saved);
    });
  }
}

function isFile(file: unknown): file is TFile { return !!file && typeof file === "object" && "extension" in file; }
export function createObsidianWorkspaceService(app: App, options: WorkspaceServiceOptions = {}): WorkspaceService {
  const adapter = app.vault.adapter;
  return new WorkspaceService({
    adapter,
    requiresPathGuard: "getBasePath" in adapter,
    create: async (path, content, check) => { check(); await app.vault.create(path, content); check(); },
    process: async (path, change) => {
      const file = app.vault.getAbstractFileByPath(path);
      if (!isFile(file) || file.path !== path) throw new WorkspaceError("not_found", "工作区文件不存在，请重新读取。");
      return app.vault.process(file, latest => { if (file.path !== path || app.vault.getAbstractFileByPath(path) !== file) throw conflict(); return change(latest); });
    },
    assertUnchangedEditor: (path, expected) => {
      for (const leaf of app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view as unknown as { file?: { path: string }; editor?: { getValue(): string }; getMode?(): string };
        if (view.file?.path === path && view.editor && view.getMode?.() !== "preview" && view.editor.getValue() !== expected) throw conflict();
      }
    }
  }, options);
}
