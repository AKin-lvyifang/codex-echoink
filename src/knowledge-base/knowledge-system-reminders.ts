import type { App } from "obsidian";
import { classifyKnowledgePath, type KnowledgeFolderBindings } from "./folder-bindings";
import { maintenanceDomainCatalog } from "./maintenance-domain-catalog";
import { readMaintenanceDomainBlocks, findMaintenanceDomainMap } from "./maintenance-domain-map";
import {
  readMaintenanceFrontmatterProperty,
  patchKnowledgeProperties,
  type KnowledgePropertyValue,
} from "./maintenance-source-frontmatter";
import { maintenanceVisibleClassification } from "./maintenance-p2-planning";
import { treeMapPendingCount } from "./maintenance-tree-map";

export interface KnowledgeSystemReminder {
  domain: string;
  mapPath: string;
  mode: "list" | "tree";
  count: number;
  threshold: number;
}
const label = (mode: "list" | "tree") => (mode === "tree" ? "待归位" : "清单");
export function systemReminderKeys(domain: string, mode: "list" | "tree") {
  return {
    count: `上次体系提醒-${domain}-${label(mode)}`,
    deferred: `暂缓体系提醒-${domain}-${label(mode)}`,
  };
}
export function knowledgeSystemReminder(
  content: string,
  domain: string,
  mapPath: string,
  mode: "list" | "tree",
  count: number,
): KnowledgeSystemReminder | null {
  const keys = systemReminderKeys(domain, mode),
    last = readMaintenanceFrontmatterProperty(content, keys.count),
    deferred = readMaintenanceFrontmatterProperty(content, keys.deferred);
  if (
    last.error ||
    deferred.error ||
    (last.present &&
      (typeof last.value !== "number" || !Number.isSafeInteger(last.value) || last.value < 0)) ||
    (deferred.present && typeof deferred.value !== "boolean")
  )
    throw new Error("体系提醒属性类型不兼容，保留原值。");
  const threshold = mode === "tree" ? 10 : 15;
  if (count < threshold || (deferred.value === true && count < Number(last.value ?? 0) + 10))
    return null;
  return { domain, mapPath, mode, count, threshold };
}
export function reminderProperties(
  reminder: KnowledgeSystemReminder,
  deferred = false,
): Record<string, KnowledgePropertyValue> {
  const keys = systemReminderKeys(reminder.domain, reminder.mode);
  return { [keys.count]: reminder.count, [keys.deferred]: deferred };
}
export function deferKnowledgeSystemReminder(
  content: string,
  reminder: KnowledgeSystemReminder,
): string {
  return patchKnowledgeProperties(content, reminderProperties(reminder, true));
}
export function knowledgeSystemReminderText(
  reminder: KnowledgeSystemReminder,
  english = false,
): string {
  return english
    ? `${reminder.domain}: ${reminder.count} ${reminder.mode === "tree" ? "unplaced notes; ready to reorganize" : "notes; ready to organize"}`
    : reminder.mode === "tree"
      ? `${reminder.domain}已有 ${reminder.count} 条待归位，可以重新梳理。`
      : `${reminder.domain}已有 ${reminder.count} 条知识，可以梳理体系。`;
}
export function collectKnowledgeSystemReminders(
  documents: readonly { path: string; content: string }[],
  wikiRoot = "",
): KnowledgeSystemReminder[] {
  const catalog = maintenanceDomainCatalog(documents),
    result: KnowledgeSystemReminder[] = [];
  for (const document of documents.filter((doc) =>
    doc.content.includes("<!-- echoink-domain-map:BEGIN"),
  ))
    for (const block of readMaintenanceDomainBlocks(document.content)) {
      const mode = block.mode ?? "list",
        count =
          mode === "tree"
            ? treeMapPendingCount(document.content.slice(block.start, block.end))
            : (catalog.domains.find((item) => item.domain === block.domain)?.count ?? 0);
      const reminder = knowledgeSystemReminder(
        document.content,
        block.domain,
        document.path,
        mode,
        count,
      );
      if (reminder) result.push(reminder);
    }
  const owners = new Set(
    documents
      .filter((doc) => doc.content.includes("<!-- echoink-domain-map:BEGIN"))
      .flatMap((doc) => readMaintenanceDomainBlocks(doc.content).map((block) => block.domain)),
  );
  for (const item of catalog.domains)
    if (!owners.has(item.domain)) {
      const entries = documents
        .filter((doc) => maintenanceVisibleClassification(doc.content).domain === item.domain)
        .map((doc) => ({
          path: doc.path,
          title: doc.path,
          domain: item.domain,
          type: maintenanceVisibleClassification(doc.content).type ?? ("概念" as const),
        }));
      const mapPath = findMaintenanceDomainMap(
        item.domain,
        entries,
        documents.map((doc) => ({ ...doc, title: doc.path, aliases: [], contentRevision: "" })),
        wikiRoot,
      );
      const reminder = knowledgeSystemReminder(
        documents.find((doc) => doc.path === mapPath)?.content ?? "",
        item.domain,
        mapPath,
        "list",
        item.count,
      );
      if (reminder) result.push(reminder);
    }
  return result;
}
/** Read-only data interface shared by the knowledge-page API and workbench. */
export async function loadKnowledgeSystemReminders(
  app: Pick<App, "vault">,
  bindings: KnowledgeFolderBindings,
): Promise<KnowledgeSystemReminder[]> {
  const documents: { path: string; content: string }[] = [];
  for (const file of app.vault.getMarkdownFiles())
    if (classifyKnowledgePath(bindings, file.path) === "wiki")
      documents.push({
        path: file.path,
        content: await (app.vault.cachedRead?.(file) ?? app.vault.read(file)),
      });
  return collectKnowledgeSystemReminders(documents, bindings.roles.wiki.writePath ?? "");
}
