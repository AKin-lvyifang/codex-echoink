/** Product copy only. Internal diagnostics and recoverable records stay intact. */
export function maintenancePageLabel(path: string): string {
  const name = path.replace(/\\/gu, "/").split("/").at(-1)?.replace(/\.(?:md|markdown)$/iu, "").trim();
  return name ? `《${name.replace(/[《》\r\n]/gu, " ").slice(0, 180)}》` : "该页面";
}

export function maintenanceFailureText(message: string, currentPath?: string, english = false): string {
  if (/没有未完成清单/u.test(message)) return english ? "No progress was saved. Continue to start organizing the original sources." : "还没有保存整理进度。继续会从原来的资料开始。";
  if (/复制来源过多|maintenance_copy_limit/u.test(message)) return english ? "This page copied too much source text and was not saved. It needs a summary with only necessary short quotes." : "这一页带入了太多原文，暂未保存，需要先提炼要点、只保留必要短引用。";
  const path = message.match(/(?:[^\s：:；;，,《》"'`]+\/)+[^\s；;，,《》"'`]+\.(?:md|markdown)/iu)?.[0] ?? currentPath;
  const page = path ? maintenancePageLabel(path) : "该页面";
  if (english) return /冲突|并发|目标.*变化|preview_stale|revision|CAS/iu.test(message)
    ? `${path ? page : "This page"} changed while it was being organized. Your edits are preserved. Continue to read it again before updating it.`
    : "This step is unfinished. Saved work is preserved; continue to check and finish the remaining work.";
  if (/来源.*变化|source.*changed/iu.test(message)) return `${path ? page : "该资料"}在整理期间已被修改，已写入的内容已保留。请点击“继续”重新核对。`;
  if (/冲突|并发|目标.*变化|preview_stale|revision|CAS/iu.test(message)) return `${page}在整理期间已被修改，为保留您的修改，已跳过该页面。请点击“继续”重新读取后再写入。`;
  if (/收尾|地图|关联补全|反链/iu.test(message)) return "链接和领域地图尚未补全，已写入的页面已保留。请点击“继续”处理剩余内容。";
  if (/目录|文件夹|路径|Raw\/Inbox/iu.test(message)) return "该资料或目标位置暂时不可用，已写入的内容已保留。请点击“继续”重新检查。";
  if (/取消|停止|中断/iu.test(message)) return "本次整理已停止，已写入的内容已保留。请点击“继续”接着处理。";
  return "此步骤尚未完成，已写入的内容已保留。请点击“继续”重新核对后处理。";
}

const INTERNAL_COPY = /\b(?:recordId|toolCallId|productRunId|maintenanceStage|aliases|writingPlan|decompositions?|sectionPatches|pendingPageCount|pendingPages|expectedTarget|sourcePaths?|targetPath|candidatePath|reverseReason|knowledge\.decision|contentRevision|sourceRevision|regionId|unitIds?|nextOffset|offset|stage|resume|CAS|WAL|revision|knowledge_maintain|authorization_failed)\b|清单|(?:[^\s]+\/)+[^\s]+\.(?:md|markdown)/iu;
export function maintenanceVisibleCopyIsSafe(text: string, question = false): boolean {
  return !INTERNAL_COPY.test(text) && (!question || !/\d+\s*\/\s*\d+/u.test(text));
}
export function maintenanceToolTitle(name: string | undefined, status?: string): string {
  const title: Record<string, string> = { knowledge_system_read: "读取领域全文", knowledge_system_propose: "提交知识体系提案", obsidian_cli: "检查笔记", note_read: "读取笔记", knowledge_read: "读取笔记", vault_search: "查找笔记", knowledge_search: "查找资料", knowledge_maintain: "整理知识库", note_create: "写入笔记", note_update: "更新笔记", metadata_update: "更新笔记信息" };
  const known = title[name ?? ""];
  if (status === "failed") return known ? `${known}未完成` : "此步骤未完成";
  if (status === "cancelled" || status === "interrupted") return "此步骤已停止";
  return known ?? (status === "completed" ? "此步骤已完成" : "正在处理资料");
}

export function maintenanceUserReceiptFromResult(value: unknown): Readonly<import("./maintenance-activity").MaintenanceUserReceipt> | null {
  if (!value || typeof value !== "object") return null;
  const outer = value as Record<string, unknown>, details = outer.details && typeof outer.details === "object" ? outer.details as Record<string, unknown> : outer;
  const raw = details.userReceipt;
  if (!raw || typeof raw !== "object") return null;
  const receipt = raw as Record<string, unknown>;
  if (receipt.version !== 1 || typeof receipt.text !== "string" || !receipt.text.trim() || receipt.text.length > 2_000 || !maintenanceVisibleCopyIsSafe(receipt.text)) return null;
  const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (receipt.sourceCount !== undefined && !integer(receipt.sourceCount)) return null;
  if (receipt.skippedSourceCount !== undefined && !integer(receipt.skippedSourceCount)) return null;
  const counts = receipt.pageCounts as Record<string, unknown> | undefined;
  if (counts && (!integer(counts.written) || !integer(counts.created) || !integer(counts.updated) || counts.created + counts.updated !== counts.written)) return null;
  return { version: 1, text: receipt.text, ...(receipt.sourceCount === undefined ? {} : { sourceCount: receipt.sourceCount }),
    ...(receipt.skippedSourceCount === undefined ? {} : { skippedSourceCount: receipt.skippedSourceCount }),
    ...(counts ? { pageCounts: { written: counts.written as number, created: counts.created as number, updated: counts.updated as number } } : {}) };
}
