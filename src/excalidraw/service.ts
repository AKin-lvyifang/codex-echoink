import { Platform, TFile, TFolder, type App } from "obsidian";
import { normalizeKnowledgeDirectory } from "../knowledge-base/folder-bindings";
import type { DrawingOutput, DrawingStyle } from "./elements";
import { drawingTemplateContent, drawingTemplatePath } from "./templates";
interface CLIResult { ok: boolean | null; mutation: string; persistence: string; data?: Record<string, unknown>; error?: { code: string; message: string } }
interface ExcalidrawInstance { manifest: { version: string }; isReady: boolean; executeCLI(request: Record<string, unknown>): Promise<CLIResult> }
export interface DrawingCreation { requestId: string; path: string; style: DrawingStyle; output: DrawingOutput }
export interface DrawingReceipt { path: string; verified: boolean; error?: string }
/** This is the sole boundary reading another plugin's instance. Never mutate its settings. */
export class ExcalidrawService {
  private readonly creations = new Map<string, { fingerprint: string; promise: Promise<DrawingReceipt> }>();
  private readonly opened = new Set<string>();
  constructor(private readonly app: App) {}
  private probe(): { instance?: ExcalidrawInstance; reason: string | null } {
    if (!Platform.isDesktopApp) return { reason: "手绘图暂只支持电脑端。" };
    const registry = (this.app as App & { plugins?: { manifests?: Record<string, unknown>; plugins?: Record<string, ExcalidrawInstance>; enabledPlugins?: Set<string> } }).plugins;
    const id = "obsidian-excalidraw-plugin", instance = registry?.plugins?.[id];
    if (!registry?.manifests?.[id] && !instance) return { reason: "请先安装 Excalidraw 2.29 或更新版本。" };
    if (!instance || registry?.enabledPlugins && !registry.enabledPlugins.has(id)) return { reason: "请先启用 Excalidraw 插件。" };
    const version = /^(\d+)\.(\d+)\.(\d+)(.*)$/u.exec(instance.manifest.version);
    if (!version || Number(version[1]) < 2 || Number(version[1]) === 2 && (Number(version[2]) < 29 || Number(version[2]) === 29 && Number(version[3]) === 0 && version[4])) return { reason: "Excalidraw 版本太低，请升级到 2.29 或更新版本。" };
    if (typeof instance.executeCLI !== "function") return { reason: "Excalidraw 缺少绘图接口，请升级插件后重试。" };
    if (!instance.isReady) return { reason: "Excalidraw 正在初始化，请稍后重试。" };
    return { instance, reason: null };
  }
  disabledReason(): string | null { return this.probe().reason; }
  private instance(): ExcalidrawInstance { const state = this.probe(); if (!state.instance || state.reason) throw new Error(state.reason ?? "Excalidraw 不可用。"); return state.instance; }
  async schema(): Promise<string> {
    const result = await this.instance().executeCLI({ apiVersion: 1, command: "schema", action: "create" });
    if (result.ok !== true || !result.data?.jsonSchema) throw new Error("未读到 Excalidraw 元素格式，请稍后重试。");
    return JSON.stringify(result.data);
  }
  choosePath(directory: string, stem: string): string {
    normalizeKnowledgeDirectory(directory);
    for (let suffix = 1; ; suffix++) {
      const target = `${directory}/${stem}${suffix === 1 ? "" : ` ${suffix}`}.excalidraw.md`;
      if (!this.app.vault.getAbstractFileByPath(target)) return target;
    }
  }
  /** Invoke only after confirmation. Fixed identity/path also protects same-session replay. */
  create(input: DrawingCreation): Promise<DrawingReceipt> {
    const fingerprint = JSON.stringify(input), previous = this.creations.get(input.requestId);
    if (previous) { if (previous.fingerprint !== fingerprint) return Promise.reject(new Error("该请求已使用，不能换名重建。")); return previous.promise; }
    const promise = this.createOnce(input); this.creations.set(input.requestId, { fingerprint, promise }); return promise;
  }
  private async folder(directory: string): Promise<void> {
    const parts = normalizeKnowledgeDirectory(directory).split("/");
    for (let index = 1; index <= parts.length; index++) {
      const path = parts.slice(0, index).join("/"), existing = this.app.vault.getAbstractFileByPath(path);
      if (existing && !(existing instanceof TFolder)) throw new Error(`文件夹被文件占用：${path}`);
      if (!existing) { try { await this.app.vault.createFolder(path); } catch (error) { if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFolder)) throw error; } }
    }
  }
  private async createOnce(input: DrawingCreation): Promise<DrawingReceipt> {
    const cli = this.instance();
    normalizeKnowledgeDirectory(input.path);
    if (!input.path.endsWith(".excalidraw.md")) throw new Error("手绘图文件格式无效。");
    if (this.app.vault.getAbstractFileByPath(input.path)) throw new Error("确认后的路径已被占用，请重新生成并确认，不会覆盖已有文件。");
    await this.folder(input.path.split("/").slice(0, -1).join("/"));
    const template = drawingTemplatePath(input.style), content = drawingTemplateContent(input.style);
    await this.folder(template.split("/").slice(0, -1).join("/"));
    const existing = this.app.vault.getAbstractFileByPath(template);
    if (existing && (!(existing instanceof TFile) || await this.app.vault.read(existing) !== content)) throw new Error(`手绘模板已被修改，请保留它并移走后重试：${template}`);
    if (!existing) await this.app.vault.create(template, content);
    // CLI drawingFile checks metadata, which is indexed asynchronously after Vault.create.
    // Wait for this exact template rather than changing global plugin settings.
    const file = this.app.vault.getAbstractFileByPath(template);
    if (!(file instanceof TFile)) throw new Error("手绘模板尚未就绪，请稍后重试。");
    for (let attempt = 0; ; attempt++) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (frontmatter?.["excalidraw-plugin"] && frontmatter["excalidraw-export-dark"] === (input.style === "blackboard")) break;
      if (attempt >= 100) throw new Error("手绘模板尚未完成识别，请稍后重试。");
      await new Promise(resolve => window.setTimeout(resolve, 50));
    }
    let result: CLIResult | undefined;
    try { result = await cli.executeCLI({ apiVersion: 1, command: "create", requestId: `echoink-${input.requestId}`, path: input.path, template, elements: input.output.elements }); }
    catch { /* An interrupted call must be reconciled at this exact path. */ }
    if (result?.ok === true && result.mutation === "applied" && result.persistence === "saved") return { path: input.path, verified: true };
    if (result?.ok === false && result.mutation === "not-applied") throw new Error(result.error?.code === "ALREADY_EXISTS" ? "确认后的路径已被占用，未覆盖已有文件。" : `Excalidraw 未创建图：${result.error?.message ?? "请检查插件后重试"}`);
    return await this.reconcile(input);
  }
  /** Read only: recover the original exact path after a restart or unknown outcome. */
  async reconcile(input: DrawingCreation): Promise<DrawingReceipt> {
    const cli = this.instance();
    const readback = await cli.executeCLI({ apiVersion: 1, command: "read", path: input.path, source: "disk", detail: "elements", limit: 200 }).catch(() => undefined);
    const actual = readback?.data?.elements;
    if (readback?.ok === true && Array.isArray(actual)) {
      const compact = (value: string) => value.replace(/\s/gu, "");
      const expectedText = input.output.elements.flatMap(element => element.text ?? element.label?.text ?? []).map(compact).sort();
      const actualText = actual.flatMap((element: Record<string, unknown>) => element.type === "text" && typeof element.originalText === "string" ? [element.originalText] : element.type === "text" && typeof element.text === "string" ? [element.text] : []).map(compact).sort();
      const boxes = actual.filter((element: Record<string, unknown>) => ["rectangle", "ellipse", "diamond"].includes(String(element.type))).length;
      const arrows = actual.filter((element: Record<string, unknown>) => element.type === "arrow" && element.startBinding && element.endBinding).length;
      if (boxes === input.output.boxCount && arrows === input.output.arrowCount && JSON.stringify(expectedText) === JSON.stringify(actualText)) return { path: input.path, verified: true };
    }
    return { path: input.path, verified: false, error: "绘图结果未确认，请先核对原路径，不要换名重建。" };
  }
  async openOnce(requestId: string, path: string): Promise<void> {
    if (this.opened.has(requestId)) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error("图已保存，但文件尚未就绪，请用打开按钮查看。");
    this.opened.add(requestId);
    await this.app.workspace.getLeaf("tab").openFile(file, { active: true });
  }
}
const services = new WeakMap<App, ExcalidrawService>();
export function getExcalidrawService(app: App): ExcalidrawService { let service = services.get(app); if (!service) { service = new ExcalidrawService(app); services.set(app, service); } return service; }
