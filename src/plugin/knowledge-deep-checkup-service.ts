import { maintenancePageTitle } from "../knowledge-base/maintenance-page-metadata";
import { knowledgeDecisionPaths } from "../knowledge-base/knowledge-pair-decisions";
import type CodexForObsidianPlugin from "../main";
import { classifyKnowledgePath } from "../knowledge-base/folder-bindings";
import { KnowledgeDeepCheckupTaskService } from "../knowledge-base/knowledge-deep-checkup-task";
import type { DeepCheckupDocument, DeepCheckupTask } from "../knowledge-base/knowledge-deep-checkup";
import { isGeneralKnowledgeWiki, isKnowledgeMap, knowledgeWikiProperties } from "../knowledge-base/knowledge-wiki-policy";
import { maintenanceVisibleClassification } from "../knowledge-base/maintenance-p2-planning";
import { readMaintenanceFrontmatterProperty } from "../knowledge-base/maintenance-source-frontmatter";
import { resolveKnowledgeMaintenanceSubmitSnapshot } from "../settings/knowledge-maintenance-submit";
import { getDesktopFsPromises } from "../platform/desktop-filesystem";
import { getDesktopPath } from "../platform/desktop-paths";
import { sha256Hex } from "../utils/sha256";
import { pluginDataDir } from "./plugin-data-paths";

export class KnowledgeDeepCheckupModelMissing extends Error {
  readonly name = "KnowledgeDeepCheckupModelMissing";
}

export function createKnowledgeDeepCheckupService(
  plugin: CodexForObsidianPlugin,
): KnowledgeDeepCheckupTaskService {
  const fs = getDesktopFsPromises();
  const path = getDesktopPath();
  const store = path.join(pluginDataDir(plugin.getVaultPath(), plugin.getPluginDataDirName()),
    "knowledge", "deep-checkup-v1.json");
  const read = async (relative: string): Promise<DeepCheckupDocument | null> => {
    const bindings = plugin.settings.knowledgeBase.folderBindings;
    if (!bindings || classifyKnowledgePath(bindings, relative) !== "wiki") return null;
    const file = plugin.app.vault.getFileByPath(relative);
    if (!file) return null;
    const content = await plugin.app.vault.read(file);
    if (!isGeneralKnowledgeWiki(knowledgeWikiProperties(content)) || isKnowledgeMap(relative, content)) return null;
    const ignored = readMaintenanceFrontmatterProperty(content, "体检忽略").value;
    const resolve = (link: string) => plugin.app.metadataCache.getFirstLinkpathDest(link, relative);
    const notDuplicates = knowledgeDecisionPaths(content, "不是重复", resolve);
    const coexisting = knowledgeDecisionPaths(content, "并列保留", resolve);
    const domain = maintenanceVisibleClassification(content).domain ?? "未分类";
    return {
      path: relative,
      title: maintenancePageTitle(content, relative),
      aliases: ["aliases", "alias"].flatMap(key => {
        const value = readMaintenanceFrontmatterProperty(content, key).value;
        return typeof value === "string" ? [value] : Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string") : [];
      }),
      content,
      revision: sha256Hex(content),
      domain,
      separateDomains: (plugin.settings.knowledgeBase.separateDomainPairs ?? [])
        .filter(pair => pair.includes(domain)).flatMap(pair => pair.filter(name => name !== domain)),
      notDuplicates,
      coexisting,
      outdatedHandled: readMaintenanceFrontmatterProperty(content, "待核实").value === true ||
        (Array.isArray(ignored) && ignored.includes("可能过时")),
    };
  };
  return new KnowledgeDeepCheckupTaskService({
    assertModel: () => {
      try { resolveKnowledgeMaintenanceSubmitSnapshot(plugin.settings); }
      catch { throw new KnowledgeDeepCheckupModelMissing("请先配置可用模型，再开始深查。快查仍可使用。"); }
    },
    documents: async () => {
      const paths = (await plugin.getKnowledgeSurfaceService()!.checkup.quick()).candidates;
      const result: DeepCheckupDocument[] = [];
      for (const path of paths) {
        const doc = await read(path);
        if (doc) result.push(doc);
      }
      return result.sort((a, b) => a.path.localeCompare(b.path));
    },
    read,
    load: async () => {
      try {
        const value = JSON.parse(await fs.readFile(store, "utf8")) as DeepCheckupTask;
        if (value.version !== 1 || !Array.isArray(value.batches)) throw new Error("深查任务格式不兼容。");
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    save: async (task) => {
      await fs.mkdir(path.dirname(store), { recursive: true });
      await fs.writeFile(store + ".tmp", JSON.stringify(task), { mode: 0o600 });
      await fs.rename(store + ".tmp", store);
    },
    generate: (prompt, signal) => plugin.generateLifestyleText(
      "你是严谨的知识库审阅者。只给有原文证据的诊断，不执行文件操作。", prompt, 7000, signal,
    ),
  });
}
