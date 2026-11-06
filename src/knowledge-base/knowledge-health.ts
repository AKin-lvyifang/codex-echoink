import { TFolder, type App } from "obsidian";
import type { KnowledgeBaseSettings } from "../settings/settings";
import { buildKnowledgeStructureHealth } from "./health-core";
import { classifyKnowledgePath, emptyKnowledgeFolderBindings } from "./folder-bindings";
import { scanKnowledgeStructure } from "./knowledge-structure-scan";

/** One score source for all surfaces. Only native metadata and already saved processing markers. */
export function loadKnowledgeHealth(app: App, settings: KnowledgeBaseSettings) {
  const bindings = settings.folderBindings ?? emptyKnowledgeFolderBindings();
  const structure = scanKnowledgeStructure(app, bindings);
  const roots = (role: "raw" | "wiki") => bindings.roles[role].readPaths;
  const exists = (role: "raw" | "wiki") =>
    roots(role).length > 0 &&
    roots(role).some((path) => app.vault.getAbstractFileByPath(path) instanceof TFolder);
  const issues: string[] = [];
  for (const [role, binding] of Object.entries(bindings.roles)) {
    if (
      binding.enabled &&
      (!binding.readPaths.length ||
        binding.readPaths.some(
          (path) => !(app.vault.getAbstractFileByPath(path) instanceof TFolder),
        ))
    )
      issues.push(`${role} 位置尚未绑定或已失效`);
  }
  let calibration = 0;
  for (const file of app.vault.getMarkdownFiles()) {
    if (
      classifyKnowledgePath(bindings, file.path) !== "raw" ||
      /(?:^|\/)index\.md$/iu.test(file.path)
    )
      continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (fm?.提炼状态 === "待校准") calibration++;
  }
  return buildKnowledgeStructureHealth({
    mappedFolders: true,
    bindingIssues: issues,
    settings: { ...settings, folderBindings: bindings },
    readFailed: structure.loading,
    limited: false,
    maintenanceHistory: settings.maintenanceHistory,
    rawExists: exists("raw"),
    wikiExists: exists("wiki"),
    wikiIndexExists: true,
    trackerExists: true,
    rawDigestStatus: { calibration },
    structure: {
      total: structure.files.length,
      broken: structure.findings.filter((finding) => finding.kind === "broken").length,
      oneWay: structure.findings.filter((finding) => finding.kind === "oneWay").length,
      isolated: structure.findings.filter((finding) => finding.kind === "isolated").length,
    },
  });
}
