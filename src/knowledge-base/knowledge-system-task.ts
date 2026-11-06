import { renderKnowledgeSystemBlock } from "./knowledge-system-map";
import { getDesktopCrypto } from "../platform/desktop-crypto";
import { applyDomainMapBlockPatches } from "./maintenance-tree-map";
import {
  validateKnowledgeDomainAnalysis,
  type KnowledgeAnalysisDocument,
  type KnowledgeDomainAnalysis,
} from "./knowledge-system-analysis";
import { backgroundMaintenancePageWrite } from "./maintenance-page-lock";
import type {
  KnowledgeSystemMovePlan,
  KnowledgeSystemMoveProgress,
  KnowledgeSystemOperation,
} from "./knowledge-system-move";

const { createHash, randomUUID } = getDesktopCrypto();
export const knowledgeSystemHash = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
export interface KnowledgeSystemChoice {
  framework: number;
  afterBlock: string;
  operations: KnowledgeSystemOperation[];
  digest: string;
  move?: KnowledgeSystemMovePlan;
}
export interface KnowledgeSystemConfirmation {
  taskId: string;
  conversationId: string;
  proposalVersion: number;
  framework: number;
  operationsDigest: string;
  move?: true;
}
export interface KnowledgeSystemTask {
  id: string;
  conversationId: string;
  domain: string;
  agentId: string;
  mapPath: string;
  bindingRevision: number;
  phase:
    | "reading"
    | "awaiting-confirmation"
    | "writing"
    | "moving"
    | "linking"
    | "waiting-maintain"
    | "interrupted"
    | "completed"
    | "deferred";
  documents: KnowledgeAnalysisDocument[];
  block: string | null;
  declined: string[];
  coverage: Record<string, { revision: string; characters: number; through: number }>;
  proposalVersion: number;
  proposal?: {
    version: number;
    analysis: KnowledgeDomainAnalysis;
    choices: KnowledgeSystemChoice[];
  };
  approved?: KnowledgeSystemConfirmation;
  write?: { path: string; before: string | null; after: string; operationId: string };
  selected?: number;
  moveProgress?: KnowledgeSystemMoveProgress;
  moveBlocker?: { conversationId?: string; title: string };
  error?: string;
  receipt?: string;
  createdAt: number;
  updatedAt: number;
}
export interface KnowledgeSystemTaskHost {
  vaultRoot: string;
  load(): Promise<KnowledgeSystemTask[]>;
  save(tasks: readonly KnowledgeSystemTask[]): Promise<void>;
  discover(
    domain: string,
  ): Promise<
    Pick<KnowledgeSystemTask, "documents" | "mapPath" | "block" | "bindingRevision" | "declined">
  >;
  createConversation(domain: string, agentId: string): Promise<string>;
  assertAccess(task: KnowledgeSystemTask, write: boolean): Promise<void>;
  read(path: string): Promise<string | null>;
  write(task: KnowledgeSystemTask, signal: AbortSignal): Promise<void>;
  planMove?(
    task: KnowledgeSystemTask,
    framework: import("./knowledge-system-analysis").KnowledgeFramework,
  ): Promise<KnowledgeSystemMovePlan | undefined>;
  checkMove?(
    task: KnowledgeSystemTask,
    plan: KnowledgeSystemMovePlan,
  ): Promise<{ conversationId?: string; title: string } | null>;
  move?(
    task: KnowledgeSystemTask,
    signal: AbortSignal,
    checkpoint: (phase: "moving" | "linking") => Promise<void>,
  ): Promise<void>;
  changed(task: KnowledgeSystemTask): Promise<void> | void;
}

/** Proposal/checkpoint state only. The only note writer is confirm(), after an exact UI binding. */
export class KnowledgeSystemTaskService {
  readonly ready: Promise<void>;
  private tasks: KnowledgeSystemTask[] = [];
  private saveFlight = Promise.resolve();
  private readonly starts = new Map<
    string,
    Promise<{ task: KnowledgeSystemTask; created: boolean }>
  >();
  private readonly writers = new Map<
    string,
    { controller: AbortController; flight: Promise<void> }
  >();
  constructor(private readonly host: KnowledgeSystemTaskHost) {
    this.ready = host.load().then(async (tasks) => {
      this.tasks = tasks;
      for (const task of tasks)
        if (["reading", "writing", "waiting-maintain", "moving", "linking"].includes(task.phase)) {
          task.phase = "interrupted";
          task.error = "上次已停下，继续时复用已读全文和提案。";
          await host.changed(task);
        } else if (task.phase === "awaiting-confirmation") await host.changed(task);
    });
  }
  list(): readonly KnowledgeSystemTask[] {
    return this.tasks;
  }
  ownsConversation(id: string): boolean {
    return this.forConversation(id) !== undefined;
  }
  hasUnfinishedMove(id: string): boolean {
    const task = this.forConversation(id);
    return !!task?.moveProgress && task.phase !== "completed";
  }
  async prepareStatusChange(id: string, status: "active" | "archived" | "deleted"): Promise<void> {
    await this.ready;
    if (status === "active" || !this.ownsConversation(id)) return;
    await this.stop(id);
    if (status === "deleted" && this.hasUnfinishedMove(id))
      throw new Error("搬家尚未完成，请先继续或归档，进度会保留。");
  }
  async detach(id: string): Promise<void> {
    await this.ready;
    if (this.hasUnfinishedMove(id)) return;
    this.tasks = this.tasks.filter((task) => task.conversationId !== id);
    const save = this.saveFlight
      .catch(() => undefined)
      .then(() => this.host.save(structuredClone(this.tasks)));
    this.saveFlight = save;
    await save;
  }
  forConversation(id: string): KnowledgeSystemTask | undefined {
    return this.tasks.find((task) => task.conversationId === id);
  }
  get(id: string): KnowledgeSystemTask {
    const task = this.tasks.find((task) => task.id === id);
    if (!task) throw new Error("梳理任务不存在。");
    return task;
  }
  start(domain: string, agentId: string): Promise<{ task: KnowledgeSystemTask; created: boolean }> {
    const existing = this.starts.get(domain);
    if (existing) return existing;
    const flight = this.create(domain, agentId).finally(() => this.starts.delete(domain));
    this.starts.set(domain, flight);
    return flight;
  }
  private async create(domain: string, agentId: string) {
    await this.ready;
    const previous = this.tasks.find(
      (task) => task.domain === domain && !["completed", "deferred"].includes(task.phase),
    );
    if (previous) return { task: previous, created: false };
    const snapshot = await this.host.discover(domain);
    if (!snapshot.documents.length) throw new Error("这个领域还没有可梳理的知识。");
    const conversationId = await this.host.createConversation(domain, agentId),
      now = Date.now();
    const task: KnowledgeSystemTask = {
      id: `knowledge-system-${randomUUID()}`,
      conversationId,
      domain,
      agentId,
      ...snapshot,
      phase: "reading",
      coverage: {},
      proposalVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.push(task);
    await this.persist(task);
    return { task, created: true };
  }
  async beginTurn(conversationId: string): Promise<void> {
    await this.ready;
    const task = this.forConversation(conversationId);
    if (!task) return;
    if (this.writers.has(task.id)) throw new Error("地图正在写入，请等待写入结束。");
    if (["completed", "deferred"].includes(task.phase))
      throw new Error("本次梳理已结束，请重新触发梳理。");
    if (task.approved?.move && (task.moveProgress?.moved.length || task.moveProgress?.currentMove))
      throw new Error("搬家尚未完成，请先继续，把剩余引用补好后再调整方案。");
    task.proposalVersion++;
    delete task.proposal;
    delete task.approved;
    delete task.write;
    delete task.moveProgress;
    delete task.moveBlocker;
    const latest = await this.host.discover(task.domain);
    task.coverage = Object.fromEntries(
      Object.entries(task.coverage).filter(([path, coverage]) =>
        latest.documents.some((doc) => doc.path === path && doc.revision === coverage.revision),
      ),
    );
    Object.assign(task, latest);
    // A new user turn revokes every old confirmation before any provider request.
    task.phase = "reading";
    delete task.error;
    await this.persist(task);
  }
  async readNext(conversationId: string, path?: string, offset?: number) {
    await this.ready;
    const task = this.owned(conversationId);
    if (task.phase !== "reading") throw new Error("请在当前梳理轮次读取或提交提案。");
    await this.host.assertAccess(task, false);
    const doc = path
      ? task.documents.find((doc) => doc.path === path)
      : task.documents.find((doc) => (task.coverage[doc.path]?.through ?? 0) < doc.content.length);
    if (path && !doc) throw new Error("只能读取本领域冻结的条目。");
    if (!doc) return { complete: true, read: this.readCount(task), total: task.documents.length };
    const start = offset ?? task.coverage[doc.path]?.through ?? 0;
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      start > (task.coverage[doc.path]?.through ?? 0)
    )
      throw new Error("请从已经读到的位置继续，不能跳过正文。");
    const end = Math.min(start + 12000, doc.content.length),
      previous = task.coverage[doc.path]?.through ?? 0;
    task.coverage[doc.path] = {
      revision: doc.revision,
      characters: doc.content.length,
      through: Math.max(previous, end),
    };
    await this.persist(task);
    return {
      path: doc.path,
      revision: doc.revision,
      content: doc.content.slice(start, end),
      start,
      end,
      totalCharacters: doc.content.length,
      cached: start < previous,
      read: this.readCount(task),
      total: task.documents.length,
      complete: this.readCount(task) === task.documents.length,
    };
  }
  readCount(task: KnowledgeSystemTask): number {
    return task.documents.filter((doc) => task.coverage[doc.path]?.through === doc.content.length)
      .length;
  }
  async propose(conversationId: string, value: unknown): Promise<{ message: string }> {
    await this.ready;
    const task = this.owned(conversationId);
    if (task.phase !== "reading") throw new Error("请在当前梳理轮次读取或提交提案。");
    await this.host.assertAccess(task, false);
    if (this.readCount(task) !== task.documents.length)
      throw new Error("请先逐页读完本领域全部正文，再提交提案。");
    const analysis = value as KnowledgeDomainAnalysis;
    validateKnowledgeDomainAnalysis(analysis, task.documents, task.domain);
    for (const framework of analysis.frameworks)
      if (framework.gaps.some((gap) => task.declined.includes(gap.title)))
        throw new Error("用户已标记不算缺口，请按当前框架重新判断。");
    const choices = await Promise.all(
      analysis.frameworks.map(async (framework, index) => {
        const afterBlock = renderKnowledgeSystemBlock(task, framework);
        const operations: KnowledgeSystemChoice["operations"] = [
          {
            kind: "domain-map",
            path: task.mapPath,
            domain: task.domain,
            before: task.block === null ? null : knowledgeSystemHash(task.block),
            after: knowledgeSystemHash(afterBlock),
          },
        ];
        return {
          framework: index,
          afterBlock,
          operations,
          digest: knowledgeSystemHash(JSON.stringify(operations)),
          move: await this.host.planMove?.(task, framework),
        };
      }),
    );
    task.proposalVersion++;
    task.proposal = { version: task.proposalVersion, analysis: structuredClone(analysis), choices };
    delete task.approved;
    delete task.write;
    task.phase = "awaiting-confirmation";
    delete task.error;
    await this.persist(task);
    return {
      message:
        "两个方案已准备好，请在确认卡中选择。等用户操作，不要重复方案或提到程序字段、编号和版本。",
    };
  }
  confirmation(
    task: KnowledgeSystemTask,
    framework: number,
    move = false,
  ): KnowledgeSystemConfirmation {
    const choice = task.proposal?.choices[framework];
    if (!choice) throw new Error("请先选择当前方案。");
    return {
      taskId: task.id,
      conversationId: task.conversationId,
      proposalVersion: task.proposal!.version,
      framework,
      operationsDigest: move && choice.move ? choice.move.digest : choice.digest,
      ...(move && choice.move ? { move: true as const } : {}),
    };
  }
  private validateConfirmation(binding: KnowledgeSystemConfirmation): KnowledgeSystemTask {
    const task = this.get(binding.taskId);
    if (!task.proposal || task.proposalVersion !== binding.proposalVersion)
      throw new Error("这份提案已失效，请查看最新方案后确认。");
    const current = this.confirmation(task, binding.framework, binding.move === true);
    if (JSON.stringify(binding) !== JSON.stringify(current))
      throw new Error("这份提案已失效，请查看最新方案后确认。");
    return task;
  }
  async confirm(binding: KnowledgeSystemConfirmation): Promise<void> {
    await this.ready;
    const task = this.validateConfirmation(binding);
    if (task.phase !== "awaiting-confirmation")
      throw new Error("当前提案不能确认，请继续任务后再确认。");
    await this.host.assertAccess(task, true);
    if (binding.move) {
      const blocker = await this.host.checkMove?.(
        task,
        task.proposal!.choices[binding.framework].move!,
      );
      if (blocker) {
        task.moveBlocker = blocker;
        task.error = `「${blocker.title}」还没完成，请先继续或结束它，再搬家。`;
        await this.persist(task);
        return;
      }
    }
    delete task.moveBlocker;
    delete task.error;
    this.validateConfirmation(binding);
    task.approved = structuredClone(binding);
    task.selected = binding.framework;
    task.phase = "waiting-maintain";
    await this.persist(task);
    return this.runWriter(task);
  }
  async stop(conversationId: string): Promise<void> {
    const task = this.forConversation(conversationId);
    if (!task || ["completed", "deferred"].includes(task.phase)) return;
    const writer = this.writers.get(task.id);
    writer?.controller.abort();
    await writer?.flight;
    if (task.phase !== "completed") {
      task.phase = "interrupted";
      task.error = "已停下，已读全文和提案已保留。";
      await this.persist(task);
    }
  }
  async resume(conversationId: string): Promise<"model" | "restored"> {
    await this.ready;
    const task = this.owned(conversationId);
    delete task.error;
    if (task.approved) {
      this.validateConfirmation(task.approved);
      await this.runWriter(task);
      return "restored";
    }
    if (task.proposal) {
      task.phase = "awaiting-confirmation";
      await this.persist(task);
      return "restored";
    }
    return "model";
  }
  async defer(conversationId: string): Promise<void> {
    const task = this.owned(conversationId);
    if (this.writers.has(task.id)) throw new Error("请先停止写入。");
    task.phase = "deferred";
    delete task.approved;
    await this.persist(task);
  }
  async settle(conversationId: string, outcome: string): Promise<void> {
    const task = this.forConversation(conversationId);
    if (!task) return;
    if (task.phase === "reading") {
      task.phase = "interrupted";
      task.error =
        outcome === "completed"
          ? "本轮尚未提交完整提案，可以继续。"
          : "已停下，继续时复用已读全文。";
    }
    await this.persist(task);
  }
  async dispose(): Promise<void> {
    for (const writer of this.writers.values()) writer.controller.abort();
    await Promise.allSettled([...this.writers.values()].map((writer) => writer.flight));
    await this.saveFlight;
  }
  private owned(conversationId: string): KnowledgeSystemTask {
    const task = this.forConversation(conversationId);
    if (
      !task ||
      ["completed", "deferred", "writing", "waiting-maintain", "moving", "linking"].includes(
        task.phase,
      )
    )
      throw new Error("当前会话没有可用的梳理提案任务。");
    return task;
  }
  private async runWriter(task: KnowledgeSystemTask): Promise<void> {
    if (this.writers.has(task.id)) return this.writers.get(task.id)!.flight;
    const controller = new AbortController();
    const flight = Promise.resolve().then(async () => {
      try {
        task.phase = "waiting-maintain";
        await this.persist(task);
        await backgroundMaintenancePageWrite(
          this.host.vaultRoot,
          task.mapPath,
          async () => {
            if (controller.signal.aborted) return;
            this.validateConfirmation(task.approved!);
            await this.host.assertAccess(task, true);
            const choice = task.proposal!.choices[task.approved!.framework];
            if (task.approved!.move) {
              const blocker = await this.host.checkMove?.(task, choice.move!);
              if (blocker) {
                task.moveBlocker = blocker;
                throw new Error(`「${blocker.title}」还没完成，请先继续或结束它，再搬家。`);
              }
              await this.host.move!(task, controller.signal, async (phase) => {
                task.phase = phase;
                await this.persist(task);
              });
            } else {
              for (const doc of task.documents)
                if (knowledgeSystemHash((await this.host.read(doc.path)) ?? "") !== doc.revision)
                  throw new Error("条目已修改，请重新梳理后确认。");
            }
            if (controller.signal.aborted) throw new Error("已停下，继续时只处理剩余步骤。");
            if (!task.write) {
              const before = await this.host.read(task.mapPath);
              const after = applyDomainMapBlockPatches(before ?? "", [
                {
                  domain: task.domain,
                  before: task.approved!.move ? choice.move!.beforeMapBlock : task.block,
                  after: task.approved!.move ? choice.move!.afterBlock : choice.afterBlock,
                },
              ]);
              task.write = {
                path: task.mapPath,
                before,
                after,
                operationId: `${task.id}:${task.proposalVersion}:${choice.framework}`,
              };
            }
            task.phase = "writing";
            await this.persist(task);
            await this.host.write(task, controller.signal);
            task.phase = "completed";
            const framework = task.proposal!.analysis.frameworks[task.approved!.framework];
            const moved = task.moveProgress?.moved.length ?? 0;
            task.receipt =
              `已梳理「${task.domain}」：${task.documents.length} 条知识、` +
              `${framework.branches.length} 个分支、${framework.gaps.length} 个缺口` +
              (moved ? `，搬了 ${moved} 篇。` : "。");
            delete task.error;
            await this.persist(task);
          },
          controller.signal,
        );
        if (controller.signal.aborted && this.get(task.id).phase !== "completed")
          throw new Error("已停下，继续时只处理未完成写入。");
      } catch (error) {
        task.phase = "interrupted";
        task.error = error instanceof Error ? error.message : String(error);
        await this.persist(task);
      } finally {
        this.writers.delete(task.id);
      }
    });
    this.writers.set(task.id, { controller, flight });
    return flight;
  }
  private async persist(task: KnowledgeSystemTask): Promise<void> {
    task.updatedAt = Date.now();
    const next = this.saveFlight
      .catch(() => undefined)
      .then(() => this.host.save(structuredClone(this.tasks)));
    this.saveFlight = next;
    await next;
    await this.host.changed(task);
  }
}
