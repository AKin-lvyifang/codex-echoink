import { requireModuleOwner } from "../agents/registry";
import { writeKnowledgeSystemMap } from "./knowledge-system-write";
import {
  planKnowledgeSystemMove,
  checkKnowledgeSystemMove,
  runKnowledgeSystemMove,
} from "./knowledge-system-move";
import { Notice } from "obsidian";
import { FuzzySuggestModal, TFile } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { getDesktopFsPromises } from "../platform/desktop-filesystem";
import { getDesktopPath } from "../platform/desktop-paths";
import { classifyKnowledgePath } from "../knowledge-base/folder-bindings";
import { knowledgeAnalysisCorpus } from "../knowledge-base/knowledge-system-analysis";
import {
  findMaintenanceDomainMap,
  readMaintenanceDomainBlocks,
} from "../knowledge-base/maintenance-domain-map";
import {
  domainMapBlock,
  rejectTreeMapGap,
  acceptTreeMapSuggestion,
} from "../knowledge-base/maintenance-tree-map";
import { readMaintenanceFrontmatterProperty } from "../knowledge-base/maintenance-source-frontmatter";
import {
  KnowledgeSystemTaskService,
  knowledgeSystemHash,
  type KnowledgeSystemTask,
} from "../knowledge-base/knowledge-system-task";
import { pluginDataDir } from "./plugin-data-paths";
import { createPiAgentCapabilityContext } from "./pi-production-runtime-composition";
import { checkAgentCapability, requireAgentCapability } from "../agents/capability-policy";
import {
  deferKnowledgeSystemReminder,
  type KnowledgeSystemReminder,
} from "../knowledge-base/knowledge-system-reminders";
import {
  maintenancePageIsHeld,
  serializeMaintenancePage,
} from "../knowledge-base/maintenance-page-lock";
const fs = getDesktopFsPromises(),
  path = getDesktopPath();

async function scan(plugin: CodexForObsidianPlugin) {
  const bindings = plugin.settings.knowledgeBase.folderBindings;
  if (!bindings?.roles.wiki.enabled || !bindings.roles.wiki.writePath)
    throw new Error("先设置知识成果目录。");
  const docs = await Promise.all(
    plugin.app.vault
      .getMarkdownFiles()
      .filter((file) => classifyKnowledgePath(bindings, file.path) === "wiki")
      .map(async (file) => {
        const content = await plugin.app.vault.cachedRead(file);
        return { path: file.path, content, revision: knowledgeSystemHash(content) };
      }),
  );
  return { bindings, docs, corpus: knowledgeAnalysisCorpus(docs) };
}
export async function knowledgeSystemDomains(plugin: CodexForObsidianPlugin) {
  const { docs, corpus } = await scan(plugin);
  return corpus.catalog.domains.map((item) => ({
    domain: item.domain,
    count: item.count,
    mode:
      docs
        .flatMap((doc) => readMaintenanceDomainBlocks(doc.content))
        .find((block) => block.domain === item.domain)?.mode ?? "list",
  }));
}
export class KnowledgeSystemDomainPicker extends FuzzySuggestModal<{
  domain: string;
  count: number;
  mode: string;
}> {
  constructor(
    private readonly plugin: CodexForObsidianPlugin,
    private readonly domains: Awaited<ReturnType<typeof knowledgeSystemDomains>>,
  ) {
    super(plugin.app);
    this.setPlaceholder("选择要梳理的领域");
  }
  getItems() {
    return this.domains;
  }
  getItemText(item: { domain: string; count: number; mode: string }) {
    return `${item.mode === "tree" ? "重新梳理" : "梳理体系"} · ${item.domain}（${item.count}）`;
  }
  onChooseItem(item: { domain: string }) {
    void this.plugin
      .getKnowledgeSystemService()
      .launch(item.domain)
      .catch(
        (error) => new Notice(error instanceof Error ? error.message : "梳理未完成，请重试。"),
      );
  }
}

/** Uses the same Obsidian adapter, approval tickets and durable write receipts as other product tasks. */
export function createProductionKnowledgeSystemService(
  plugin: CodexForObsidianPlugin,
): KnowledgeSystemService {
  const root = plugin.getVaultPath(),
    store = path.join(
      pluginDataDir(root, plugin.getPluginDataDirName()),
      "pi-agent-product-v1",
      "knowledge-system",
      "tasks.json",
    );
  const read = async (relative: string) => {
    const file = plugin.app.vault.getAbstractFileByPath(relative);
    return file instanceof TFile ? plugin.app.vault.read(file) : null;
  };
  const service = new KnowledgeSystemService(plugin, {
    vaultRoot: root,
    load: async () => {
      try {
        const value = JSON.parse(await fs.readFile(store, "utf8")) as {
          version: number;
          tasks: KnowledgeSystemTask[];
        };
        if (value.version !== 1 || !Array.isArray(value.tasks))
          throw new Error("梳理检查点不兼容。");
        return value.tasks;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    save: async (tasks) => {
      await fs.mkdir(path.dirname(store), { recursive: true });
      await fs.writeFile(store + ".tmp", JSON.stringify({ version: 1, tasks }), { mode: 0o600 });
      await fs.rename(store + ".tmp", store);
    },
    discover: async (domain) => {
      const { bindings, docs, corpus } = await scan(plugin),
        documents = corpus.documents.filter((doc) => doc.domain === domain);
      const entries = documents.map((doc) => ({
        path: doc.path,
        title: doc.path.split("/").at(-1)!.replace(/\.md$/iu, ""),
        type: "概念" as const,
        domain,
      }));
      const mapPath = findMaintenanceDomainMap(
        domain,
        entries,
        docs.map((doc) => ({
          ...doc,
          title: doc.path,
          aliases: [],
          contentRevision: doc.revision,
        })),
        bindings.roles.wiki.writePath!,
      );
      const content = docs.find((doc) => doc.path === mapPath)?.content ?? "",
        declined = readMaintenanceFrontmatterProperty(content, "不算缺口");
      if (
        declined.error ||
        (declined.present &&
          (!Array.isArray(declined.value) ||
            declined.value.some((value) => typeof value !== "string")))
      )
        throw new Error("不算缺口属性类型不兼容，保留原值。");
      return {
        documents,
        mapPath,
        block: domainMapBlock(content, domain),
        bindingRevision: bindings.revision,
        declined: (declined.value as string[]) ?? [],
      };
    },
    createConversation: async (domain, agentId) => {
      const id = `knowledge-system-${crypto.randomUUID()}`;
      await plugin.createPiConversation({
        conversationId: id,
        agentId,
        title: `梳理${domain}`,
        titleSource: "fallback",
        cwd: root,
        defaultMemoryMode: "no_memory",
        taskStatus: "running",
        taskStartedAt: Date.now(),
        businessKey: `knowledge-system:${domain}`,
      });
      return id;
    },
    assertAccess: async (task, write) => {
      const entry = await plugin.readPiConversationCatalogEntry(task.conversationId);
      if (!entry || entry.status !== "active" || entry.agentId !== task.agentId)
        throw new Error("梳理会话或负责人已变化，请重新触发。");
      const access = plugin.getCodexView()?.knowledgeSystemWorkspaceAccess(task.conversationId) ?? {
        permission:
          plugin.settings.taskWorkspace?.replyDrafts[task.conversationId]?.selectedPermission ??
          plugin.settings.defaultPermission,
        mode: plugin.settings.defaultMode,
        memoryMode: "no_memory" as const,
      };
      if (write && (access.permission === "read-only" || access.mode !== "agent"))
        throw new Error("当前工作区只读，请允许写入并切到 Agent 模式后再确认。");
      requireAgentCapability(
        checkAgentCapability(
          createPiAgentCapabilityContext(plugin, task.agentId, [], access),
          "knowledge",
          write ? "write" : "read",
        ),
      );
      const bindings = plugin.settings.knowledgeBase.folderBindings;
      if (
        !bindings ||
        bindings.revision !== task.bindingRevision ||
        classifyKnowledgePath(bindings, task.mapPath) !== "wiki" ||
        task.documents.some((doc) => classifyKnowledgePath(bindings, doc.path) !== "wiki")
      )
        throw new Error("知识库目录已变化，请重新梳理。");
    },
    read,
    planMove: (task, framework) => planKnowledgeSystemMove(plugin, task, framework),
    checkMove: (task, plan) => checkKnowledgeSystemMove(plugin, task, plan),
    move: (task, signal, checkpoint) => runKnowledgeSystemMove(plugin, task, signal, checkpoint),
    write: (task, signal) => writeKnowledgeSystemMap(plugin, task, signal),
    changed: async (task) => {
      const status =
        task.phase === "completed" || task.phase === "deferred"
          ? "completed"
          : task.phase === "awaiting-confirmation"
            ? "waiting"
            : task.phase === "interrupted"
              ? "interrupted"
              : "running";
      const movePlan = task.proposal?.choices[task.approved?.framework ?? 0].move;
      await plugin.setPiConversationTaskMetadata(task.conversationId, {
        taskStatus: status,
        taskStage:
          task.phase === "reading"
            ? `已读 ${service.readCount(task)} / ${task.documents.length} 篇`
            : task.phase === "awaiting-confirmation"
              ? "等待确认框架"
              : task.phase === "waiting-maintain"
                ? "等待知识维护结束"
                : task.phase === "writing"
                  ? "正在写入地图"
                  : task.phase === "moving"
                    ? `已搬 ${task.moveProgress?.moved.length ?? 0} / ${movePlan?.files.length ?? 0} 篇`
                    : task.phase === "linking"
                      ? `已同步 ${task.moveProgress?.linked.length ?? 0} 篇引用`
                      : task.phase === "interrupted"
                        ? "梳理已停下"
                        : "梳理完成",
        ...(status === "waiting"
          ? {
              pendingResponse: {
                kind: "confirmation",
                runId: task.id,
                questionId: String(task.proposalVersion),
              },
            }
          : { pendingResponse: undefined }),
        resultSummary: status === "completed" ? task.receipt : undefined,
        ...(status === "completed"
          ? { taskCompletedAt: Date.now() }
          : { taskCompletedAt: undefined }),
      });
      plugin.getConversationRunService().refreshTask(task.conversationId);
      plugin.notifyHomeSurfacesChanged();
      service.notifyChanged(task);
    },
  });
  return service;
}

export class KnowledgeSystemService extends KnowledgeSystemTaskService {
  private readonly listeners = new Set<(task?: KnowledgeSystemTask) => void>();
  constructor(
    private readonly plugin: CodexForObsidianPlugin,
    host: import("../knowledge-base/knowledge-system-task").KnowledgeSystemTaskHost,
  ) {
    super(host);
  }

  subscribe(listener: (task?: KnowledgeSystemTask) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notifyChanged(task?: KnowledgeSystemTask): void {
    for (const listener of this.listeners) listener(task);
  }

  override async detach(id: string): Promise<void> {
    await super.detach(id);
    this.notifyChanged();
  }

  async deferReminder(reminder: KnowledgeSystemReminder): Promise<void> {
    await this.editMap(reminder.mapPath, (content) =>
      deferKnowledgeSystemReminder(content, reminder),
    );
  }

  async rejectGap(mapPath: string, domain: string, title: string): Promise<void> {
    await this.editMap(mapPath, (content) => rejectTreeMapGap(content, domain, title));
  }

  async acceptPlacement(
    mapPath: string,
    domain: string,
    entryPath: string,
    branch: string,
  ): Promise<void> {
    const { corpus } = await scan(this.plugin);
    const entries = corpus.documents
      .filter((doc) => doc.domain === domain)
      .map((doc) => ({
        path: doc.path,
        domain,
        title: doc.path.split("/").at(-1)!.replace(/\.md$/iu, ""),
        type: "概念" as const,
      }));
    await this.editMap(mapPath, (content) =>
      acceptTreeMapSuggestion(content, domain, mapPath, entryPath, branch, entries),
    );
  }

  private async editMap(mapPath: string, update: (content: string) => string): Promise<void> {
    const owner = requireModuleOwner(this.plugin.settings.agentRegistry, "knowledge-base");
    requireAgentCapability(
      checkAgentCapability(
        createPiAgentCapabilityContext(this.plugin, owner.id, [], {
          permission: this.plugin.settings.defaultPermission,
          mode: this.plugin.settings.defaultMode,
          memoryMode: "no_memory",
        }),
        "knowledge",
        "write",
      ),
    );
    const bindings = this.plugin.settings.knowledgeBase.folderBindings;
    if (!bindings || classifyKnowledgePath(bindings, mapPath) !== "wiki") {
      throw new Error("知识库目录已变化，请刷新后重试。");
    }
    await serializeMaintenancePage(this.plugin.getVaultPath(), mapPath, async () => {
      if (maintenancePageIsHeld(this.plugin.getVaultPath(), mapPath)) {
        throw new Error("地图正在维护，结束后再试。");
      }
      const file = this.plugin.app.vault.getAbstractFileByPath(mapPath);
      if (!(file instanceof TFile)) throw new Error("地图还未生成，请先梳理体系。");
      await this.plugin.app.vault.process(file, update);
    });
  }

  async chooseDomain(): Promise<void> {
    try {
      const domains = await knowledgeSystemDomains(this.plugin);
      if (!domains.length) {
        new Notice("还没有可梳理的领域。");
        return;
      }
      new KnowledgeSystemDomainPicker(this.plugin, domains).open();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "领域暂时读不到，请重试。");
    }
  }

  async launch(domain: string): Promise<string> {
    const owner = requireModuleOwner(this.plugin.settings.agentRegistry, "knowledge-base");
    const { task, created } = await this.start(domain, owner.id);
    const archived = !created && this.hasUnfinishedMove(task.conversationId) &&
      (await this.plugin.readPiConversationCatalogEntry(task.conversationId))?.status === "archived";
    if (archived) await this.plugin.setPiConversationStatus(task.conversationId, "active");
    await this.plugin.openTaskDetail(task.conversationId);
    if (archived) await this.plugin.resumeTask(task.conversationId);
    else if (created) {
      try {
        const view = this.plugin.getCodexView();
        if (!view) throw new Error("对话栏尚未就绪，请重试。");
        await view.startKnowledgeSystemConversation(
          task.conversationId,
          `请为「${domain}」梳理知识体系。先逐页读完全文，再给我两个框架方案，等我确认。`,
        );
      } catch (error) {
        await this.settle(task.conversationId, "failed");
        throw error;
      }
    }
    return task.conversationId;
  }
}
