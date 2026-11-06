import { sha256Hex } from "../utils/sha256";

export type KnowledgeSystemOperation =
  | { kind: "domain-map"; path: string; domain: string; before: string | null; after: string }
  | { kind: "move"; from: string; to: string; before: string }
  | { kind: "links"; path: string; before: string; after: string };
export interface KnowledgeSystemMoveFile {
  from: string;
  to: string;
  revision: string;
}
export interface KnowledgeSystemMoveLinks {
  sourcePath: string;
  path: string;
  before: string;
  after: string;
}
export interface KnowledgeSystemMovePlan {
  files: KnowledgeSystemMoveFile[];
  links: KnowledgeSystemMoveLinks[];
  beforeMapBlock: string | null;
  afterBlock: string;
  operations: KnowledgeSystemOperation[];
  digest: string;
}
export interface KnowledgeSystemMoveProgress {
  moved: string[];
  linked: string[];
  currentMove?: string;
  linkingPaused?: boolean;
  rescanned?: boolean;
}
export interface KnowledgeSystemMoveHost {
  read(path: string): Promise<string | null>;
  rename(from: string, to: string): Promise<void>;
  syncPaths(from: string, to: string): Promise<void>;
  writeLinks(patch: KnowledgeSystemMoveLinks): Promise<void>;
  pauseLinking(): Promise<void>;
  rescanLinking(files: readonly KnowledgeSystemMoveFile[]): Promise<void>;
}

/** A durable rename is identified by its recorded effect and endpoints, never equal before/after content. */
export async function executeKnowledgeSystemMove(
  plan: KnowledgeSystemMovePlan,
  progress: KnowledgeSystemMoveProgress,
  host: KnowledgeSystemMoveHost,
  checkpoint: (phase: "moving" | "linking") => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const active = () => {
    if (signal.aborted) throw new Error("已停下，继续时只补剩余搬家和引用。");
  };
  if (!progress.linkingPaused) {
    await host.pauseLinking();
    progress.linkingPaused = true;
    await checkpoint("moving");
  }
  for (const file of plan.files) {
    active();
    if (progress.moved.includes(file.from)) continue;
    const [source, target] = await Promise.all([host.read(file.from), host.read(file.to)]);
    if (source !== null && target === null) {
      if (sha256Hex(source) !== file.revision)
        throw new Error(`条目已修改，请先核对：${file.from}`);
      progress.currentMove = file.from;
      await checkpoint("moving");
      active();
      await host.rename(file.from, file.to);
    } else if (source === null && target !== null && progress.currentMove === file.from) {
      await host.syncPaths(file.from, file.to);
    } else throw new Error(`搬家位置已变化，原文件保留：${file.from}`);
    if ((await host.read(file.from)) !== null || (await host.read(file.to)) === null) {
      throw new Error(`搬家尚未核对：${file.from}`);
    }
    progress.moved.push(file.from);
    delete progress.currentMove;
    await checkpoint("moving");
  }
  for (const patch of plan.links) {
    active();
    if (progress.linked.includes(patch.path)) continue;
    const current = await host.read(patch.path);
    if (current !== patch.after) {
      if (current !== patch.before) throw new Error(`引用笔记有新修改，保留原文：${patch.path}`);
      await host.writeLinks(patch);
    }
    if ((await host.read(patch.path)) !== patch.after)
      throw new Error(`引用尚未核对：${patch.path}`);
    progress.linked.push(patch.path);
    await checkpoint("linking");
  }
  active();
  if (!progress.rescanned) {
    await host.rescanLinking(plan.files);
    progress.rescanned = true;
    await checkpoint("linking");
  }
}
