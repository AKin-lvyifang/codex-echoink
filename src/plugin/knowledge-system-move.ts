import { TFile, TFolder } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { KnowledgeSystemTask } from "../knowledge-base/knowledge-system-task";
import { knowledgeSystemHash } from "../knowledge-base/knowledge-system-task";
import type {
  KnowledgeFramework,
  KnowledgeTreeEntry,
} from "../knowledge-base/knowledge-system-analysis";
import { renderKnowledgeSystemBlock } from "../knowledge-base/knowledge-system-map";
import { domainMapBlock } from "../knowledge-base/maintenance-tree-map";
import { captureKnowledgeMoveLinks } from "../knowledge-base/knowledge-move-links";
import {
  knowledgeMayOrganizeMove,
  knowledgeOrganizationBinding,
} from "../knowledge-base/folder-organization";
import { isP1Open } from "../knowledge-base/maintenance-record";
import {
  maintenancePageIsHeld,
  serializeMaintenancePage,
} from "../knowledge-base/maintenance-page-lock";
import {
  executeKnowledgeSystemMove,
  type KnowledgeSystemMoveFile,
  type KnowledgeSystemMovePlan,
  type KnowledgeSystemOperation,
} from "../knowledge-base/knowledge-system-move";

const segment = (value: string): string => {
  const clean = value
    .replace(/[<>:"/\\|?*#[\]\r\n]/gu, "_")
    .trim()
    .replace(/^[. ]+|[. ]+$/gu, "");
  if (!clean) throw new Error("领域或分支名称无法用于文件夹，请调整后重试。");
  return clean;
};

export async function planKnowledgeSystemMove(
  plugin: CodexForObsidianPlugin,
  task: KnowledgeSystemTask,
  framework: KnowledgeFramework,
): Promise<KnowledgeSystemMovePlan | undefined> {
  const bindings = plugin.settings.knowledgeBase.folderBindings;
  if (!bindings) return undefined;
  const files: KnowledgeSystemMoveFile[] = [];
  const targets = new Set<string>();
  const planEntries = (entries: readonly KnowledgeTreeEntry[], branch: string): boolean => {
    for (const entry of entries) {
      const owner = knowledgeOrganizationBinding(bindings, entry.path);
      if (owner?.role !== "wiki") return false;
      const to = `${owner.root}/${segment(task.domain)}/${segment(branch)}/${entry.path.split("/").at(-1)}`;
      if (!knowledgeMayOrganizeMove(bindings, entry.path, to)) return false;
      if (targets.has(to)) throw new Error(`搬家目标重名，请调整条目或方案：${to}`);
      targets.add(to);
      if (entry.path !== to) {
        if (plugin.app.vault.getAbstractFileByPath(to))
          throw new Error(`搬家目标已存在，原文件保留：${to}`);
        files.push({
          from: entry.path,
          to,
          revision: task.documents.find((doc) => doc.path === entry.path)!.revision,
        });
      }
      if (!planEntries(entry.children ?? [], branch)) return false;
    }
    return true;
  };
  for (const branch of framework.branches)
    if (!planEntries(branch.entries, branch.title)) return undefined;
  if (!planEntries(framework.unplaced, "待归位") || !files.length) return undefined;
  const links = await captureKnowledgeMoveLinks(plugin.app, files);
  const paths = new Map(files.map((file) => [file.from, file.to]));
  const mapFile = plugin.app.vault.getFileByPath(task.mapPath);
  const map = mapFile ? await plugin.app.vault.read(mapFile) : "";
  const beforeMapBlock = domainMapBlock(
    links.find((patch) => patch.sourcePath === task.mapPath)?.after ?? map,
    task.domain,
  );
  const mappedEntries = (entries: readonly KnowledgeTreeEntry[]): KnowledgeTreeEntry[] =>
    entries.map((entry) => ({
      ...entry,
      path: paths.get(entry.path) ?? entry.path,
      children: mappedEntries(entry.children ?? []),
    }));
  const mapped: KnowledgeFramework = {
    ...framework,
    branches: framework.branches.map((branch) => ({
      ...branch,
      entries: mappedEntries(branch.entries),
    })),
    unplaced: mappedEntries(framework.unplaced),
  };
  const afterBlock = renderKnowledgeSystemBlock(
    {
      ...task,
      block: beforeMapBlock,
      documents: task.documents.map((doc) => ({ ...doc, path: paths.get(doc.path) ?? doc.path })),
    },
    mapped,
  );
  const operations: KnowledgeSystemOperation[] = [
    {
      kind: "domain-map",
      path: task.mapPath,
      domain: task.domain,
      before: task.block === null ? null : knowledgeSystemHash(task.block),
      after: knowledgeSystemHash(afterBlock),
    },
    ...files.map(
      (file): KnowledgeSystemOperation => ({
        kind: "move",
        from: file.from,
        to: file.to,
        before: file.revision,
      }),
    ),
    ...links.map(
      (patch): KnowledgeSystemOperation => ({
        kind: "links",
        path: patch.path,
        before: knowledgeSystemHash(patch.before),
        after: knowledgeSystemHash(patch.after),
      }),
    ),
  ];
  return {
    files,
    links,
    beforeMapBlock,
    afterBlock,
    operations,
    digest: knowledgeSystemHash(JSON.stringify(operations)),
  };
}

export async function checkKnowledgeSystemMove(
  plugin: CodexForObsidianPlugin,
  task: KnowledgeSystemTask,
  plan: KnowledgeSystemMovePlan,
) {
  const bindings = plugin.settings.knowledgeBase.folderBindings;
  if (
    !bindings ||
    plan.files.some((file) => !knowledgeMayOrganizeMove(bindings, file.from, file.to))
  ) {
    throw new Error("搬家范围或权限已变化，请重新梳理，或取消搬家后只改地图。");
  }
  const paths = new Set(task.documents.map((doc) => doc.path));
  for (const record of await plugin.getKnowledgeSurfaceService()!.getMaintenanceRecords()) {
    if (!isP1Open(record)) continue;
    const state = record.p1!;
    const sameDomain =
      state.writingPlan.some(
        (item) => paths.has(item.targetPath) || item.knowledge?.domain === task.domain,
      ) ||
      state.decompositions.some((decomposition) =>
        decomposition.units.some((unit) => typeof unit !== "string" && unit.domain === task.domain),
      ) ||
      state.p2?.treeJobs?.some((job) => job.domain === task.domain);
    if (!sameDomain) continue;
    const origin = record.originConversationId;
    const entry = origin ? await plugin.readPiConversationCatalogEntry(origin) : null;
    if (entry && entry.status !== "active") continue;
    return {
      conversationId: origin,
      title: entry?.title || record.summary || `${task.domain}维护任务`,
    };
  }
  if (!task.moveProgress?.moved.length && !task.moveProgress?.currentMove) {
    for (const doc of task.documents) {
      const file = plugin.app.vault.getFileByPath(doc.path);
      if (!file || knowledgeSystemHash(await plugin.app.vault.read(file)) !== doc.revision) {
        throw new Error("条目已修改，请重新梳理后确认。");
      }
    }
    for (const patch of plan.links) {
      const file = plugin.app.vault.getFileByPath(patch.sourcePath);
      if (!file || (await plugin.app.vault.read(file)) !== patch.before)
        throw new Error(`引用笔记已变化，请刷新提案：${patch.sourcePath}`);
    }
  }
  return null;
}

export async function runKnowledgeSystemMove(
  plugin: CodexForObsidianPlugin,
  task: KnowledgeSystemTask,
  signal: AbortSignal,
  checkpoint: (phase: "moving" | "linking") => Promise<void>,
): Promise<void> {
  const plan = task.proposal!.choices[task.approved!.framework].move!;
  const root = plugin.getVaultPath();
  const surface = plugin.getKnowledgeSurfaceService()!;
  task.moveProgress ??= { moved: [], linked: [] };
  const read = async (path: string) => {
    const file = plugin.app.vault.getFileByPath(path);
    return file ? plugin.app.vault.read(file) : null;
  };
  const available = (path: string) => {
    if (maintenancePageIsHeld(root, path))
      throw new Error("涉及的笔记正在维护，请先继续或结束维护任务。");
  };
  await executeKnowledgeSystemMove(
    plan,
    task.moveProgress,
    {
      read,
      rename: async (from, to) =>
        serializeMaintenancePage(root, from, async () => {
          available(from);
          available(to);
          const parents = to.split("/").slice(0, -1);
          for (let count = 1; count <= parents.length; count++) {
            const directory = parents.slice(0, count).join("/");
            const existing = plugin.app.vault.getAbstractFileByPath(directory);
            if (!existing) await plugin.app.vault.createFolder(directory);
            else if (!(existing instanceof TFolder))
              throw new Error(`搬家位置不是文件夹：${directory}`);
          }
          await surface.moveKnowledgeSystemNote(from, to);
        }),
      syncPaths: (from, to) => surface.syncKnowledgeSystemMove(from, to),
      writeLinks: async (patch) => {
        const write = async () => {
          available(patch.path);
          const file = plugin.app.vault.getAbstractFileByPath(patch.path);
          if (!(file instanceof TFile)) throw new Error(`引用笔记已移动：${patch.path}`);
          await plugin.app.vault.process(file, (current) => {
            if (current !== patch.before)
              throw new Error(`引用笔记有新修改，原文保留：${patch.path}`);
            return patch.after;
          });
        };
        // The task already holds this map's gate while executing the move.
        if (patch.path === task.mapPath) await write();
        else await serializeMaintenancePage(root, patch.path, write);
      },
      pauseLinking: () => surface.linking.pauseForKnowledgeMove(),
      rescanLinking: (files) => surface.linking.rescanAfterKnowledgeMove(files),
    },
    checkpoint,
    signal,
  );
}
