import { Notice, TFile, normalizePath, type App, type WorkspaceLeaf } from "obsidian";
import type { SettingsLanguage } from "../settings/settings";
import { homeCopy } from "./home-i18n";

/**
 * Opens Obsidian's core Graph View through the public Workspace leaf API.
 * The graph implementation and its settings remain entirely owned by Obsidian.
 */
export async function openObsidianGraphLeaf(
  app: App,
  language: SettingsLanguage = "zh-CN",
  options: { reuseExisting?: boolean } = {}
): Promise<boolean> {
  try {
    let leaf = options.reuseExisting === false ? undefined : app.workspace.getLeavesOfType("graph")[0];
    if (!leaf) {
      leaf = app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: "graph", active: true, state: {} });
    }
    await app.workspace.revealLeaf(leaf);
    if (leaf.getViewState().type !== "graph") {
      throw new Error("Obsidian did not activate the Graph View");
    }
    return true;
  } catch (error) {
    console.warn("EchoInk 无法打开 Obsidian 原生图谱", error);
    new Notice(homeCopy(language).graph.cannotOpenGraph);
    return false;
  }
}

/** Opens the folder's notes even when no index note exists. */
export async function openObsidianFolderGraphLeaf(
  app: App,
  directories: readonly string[],
  language: SettingsLanguage = "zh-CN"
): Promise<boolean> {
  const roots = [...new Set(directories.map((path) => normalizePath(path).replace(/\/$/u, "")))].filter(Boolean);
  if (!roots.length) return false;
  // Anchor the folder boundary: "wiki-backup" must not match "wiki".
  const escaped = roots.map((path) => path.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&"));
  const search = `match-case:path:/^(?:${escaped.join("|")})\\//`;
  let leaf: WorkspaceLeaf | undefined;
  try {
    leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: "graph", active: true, state: {} });
    if (leaf.getViewState().type !== "graph") throw new Error("Obsidian did not activate the Graph View");
    // Graph View does not read filters from Workspace state. Its core engine
    // owns the same options as the native Filters panel (verified in Obsidian).
    const engine = (leaf.view as unknown as {
      dataEngine?: {
        setOptions(options: Record<string, unknown>): void;
        getOptions(): { search?: string };
        onOptionsChange: (() => void) & { cancel?: () => void };
      };
    }).dataEngine;
    if (!engine?.setOptions || !engine.getOptions) throw new Error("Obsidian graph filters are unavailable");
    // This new leaf is a folder view: keep its options separate from the global
    // graph preferences, including the engine's deferred search callbacks.
    engine.onOptionsChange?.cancel?.();
    engine.onOptionsChange = () => undefined;
    engine.setOptions({ search, showOrphans: true, hideUnresolved: true });
    if (engine.getOptions().search !== search) throw new Error("Obsidian did not apply the folder filter");
    await app.workspace.revealLeaf(leaf);
    return true;
  } catch (error) {
    leaf?.detach();
    console.warn("EchoInk 无法打开 Obsidian 目录图谱", error);
    new Notice(homeCopy(language).graph.folderFilterUnavailable);
    // Existing graph leaves may themselves be directory views. A fresh leaf
    // lets Obsidian load the user's saved global options without inheriting one.
    return await openObsidianGraphLeaf(app, language, { reuseExisting: false });
  }
}

/**
 * Opens a new native Local Graph leaf centered on one existing Vault file.
 * EchoInk supplies only the center file; Obsidian owns the graph neighborhood,
 * rendering, filters, and interaction.
 */
export async function openObsidianLocalGraphLeaf(
  app: App,
  indexPath: string,
  language: SettingsLanguage = "zh-CN"
): Promise<boolean> {
  const normalizedPath = normalizePath(indexPath);
  const indexFile = app.vault.getAbstractFileByPath(normalizedPath);
  if (!(indexFile instanceof TFile)) {
    new Notice(homeCopy(language).graph.missingVaultFile(normalizedPath));
    return false;
  }

  try {
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: "localgraph",
      active: true,
      state: { file: normalizedPath }
    });
    const viewState = leaf.getViewState();
    if (viewState.type !== "localgraph" || viewState.state?.file !== normalizedPath) {
      throw new Error("Obsidian did not activate the requested Local Graph");
    }
    await app.workspace.revealLeaf(leaf);
    return true;
  } catch (error) {
    console.warn("EchoInk 无法打开 Obsidian 原生局部图谱", error);
    new Notice(homeCopy(language).graph.cannotOpenLocalGraph);
    return false;
  }
}
