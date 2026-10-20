import { TFile, type App } from "obsidian";
import { nativeJournalPathForDate, readNativeJournalContext, readNativeJournalSettings } from "./native-journal";
import type { KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { workbenchFingerprint, workbenchStoreForApp, type JournalTemplateBaseline } from "./workbench-records";

export interface WorkbenchJournalDay { state: "empty" | "body" | "unknown"; path: string; text: string; reason?: string }
const imageExtension = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/iu;

/** YAML, empty headings and comments alone are never journal content. */
export function journalContentLines(content: string, keepHeadings = false): string[] {
  return content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n")
    .replace(/^---\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/u, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .split("\n").map(line => line.trim())
    .filter(line => line && (keepHeadings ? !/^#{1,6}\s*\d{4}[-/]\d{2}[-/]\d{2}\s*$/u.test(line) : !/^#{1,6}(?:\s|$)/u.test(line)) && !/^(?:[-*_]\s*){3,}$/u.test(line)
      && !/^[-+*]\s*(?:\[[ xX]\])?\s*$/u.test(line) && !/^\|[\s:|\-]*\|$/u.test(line));
}
export function journalTemplateBaseline(content: string): JournalTemplateBaseline {
  const lines = journalContentLines(content, true).map(workbenchFingerprint);
  return { fingerprint: workbenchFingerprint(lines.join("\n")), lines };
}
export async function recordWorkbenchJournalTemplate(app: App, targetPath: string, template: string): Promise<void> {
  const store = workbenchStoreForApp(app);
  if (store) await store.update(draft => { draft.journals[targetPath] = journalTemplateBaseline(template); });
}

function subtractTemplate(lines: string[], baseline: JournalTemplateBaseline): string[] {
  const remaining = [...baseline.lines];
  return lines.filter(line => {
    const index = remaining.indexOf(workbenchFingerprint(line));
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
}
function hasImage(app: App, targetPath: string, lines: string[]): boolean {
  for (const line of lines) {
    const links = [...line.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/gu)]
      .map(match => match[1] ?? match[2] ?? match[3]);
    for (const link of links) {
      const raw = link.split(/[?#]/u)[0];
      if (!raw || !imageExtension.test(raw)) continue;
      const file = app.metadataCache.getFirstLinkpathDest(raw, targetPath);
      if (file instanceof TFile && imageExtension.test(file.path)) return true;
    }
  }
  return false;
}
function prose(lines: string[]): string {
  return lines.join("\n").replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/^#{1,6}\s*/gmu, "")
    .replace(/^\s*(?:[-+*]\s*(?:\[[ xX]\])?|\d+[.)])\s*$/gmu, "").replace(/[|\s]/gu, " ").trim();
}

export async function readWorkbenchJournalDay(
  app: App, date: Date, options: { legacyDirectory?: string; bindings?: KnowledgeFolderBindings | null; baseline?: JournalTemplateBaseline }
): Promise<WorkbenchJournalDay> {
  let targetPath = "";
  try {
    const settings = readNativeJournalSettings(app, options.legacyDirectory, options.bindings);
    if (!settings.available) return { state: "unknown", path: "", text: "", reason: "日记位置尚未就绪" };
    targetPath = nativeJournalPathForDate(app, date, options.legacyDirectory, options.bindings);
    const file = app.vault.getAbstractFileByPath(targetPath);
    if (!file) return { state: "empty", path: targetPath, text: "" };
    if (!(file instanceof TFile)) return { state: "unknown", path: targetPath, text: "", reason: "日记路径被目录占用" };
    const content = await app.vault.read(file), lines = journalContentLines(content, true);
    if (!lines.length) return { state: "empty", path: targetPath, text: "" };
    let baseline = options.baseline;
    if (!baseline) {
      const context = await readNativeJournalContext(app, { now: date, legacyDirectory: options.legacyDirectory, bindings: options.bindings });
      const current = journalTemplateBaseline(context.templateContent);
      if (journalTemplateBaseline(content).fingerprint === current.fingerprint) return { state: "empty", path: targetPath, text: "" };
      // An earlier custom template cannot be reconstructed. Do not label its prompts as writing.
      return { state: "unknown", path: targetPath, text: "", reason: "旧日记缺少可核实的初始模板" };
    }
    const extra = subtractTemplate(lines, baseline), text = prose(extra);
    if (text || hasImage(app, targetPath, extra)) return { state: "body", path: targetPath, text };
    return { state: "empty", path: targetPath, text: "" };
  } catch (error) {
    return { state: "unknown", path: targetPath, text: "", reason: error instanceof Error ? error.message : String(error) };
  }
}
