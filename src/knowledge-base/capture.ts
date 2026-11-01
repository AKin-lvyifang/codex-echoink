import { getDesktopFs, getDesktopFsPromises } from "../platform/desktop-filesystem";
import { getDesktopPath } from "../platform/desktop-paths";
import { resolveKnowledgeRoleTarget, getKnowledgeFolderBindings } from "./root-paths";
import { resolveKnowledgePath } from "./root-paths";
import { knowledgeCollectionDirectory, KNOWLEDGE_COLLECTION_LABELS, knowledgeCollectionTargets, type KnowledgeCollectionKind } from "./folder-bindings";

import { Notice, normalizePath, requestUrl, TFile } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { StoredAttachment } from "../settings/settings";
import type { CaptureLinkKind, CaptureLinkFeedback } from "../ui/capture-link-modal";
import { SUPPORTED_RAW_EXTENSIONS } from "./discovery";
import { collectionFileKind } from "./collection-file-types";
import { formatDateForFile, pad } from "./utils";
import {
  extractArticleMarkdown,
  extractFirstUrl,
  isHtmlVerificationBlocked,
  sanitizeWebCaptureFileName
} from "./web-capture";

const { constants: fsConstants } = getDesktopFs();
const fsp = getDesktopFsPromises();
const path = getDesktopPath();


export class KnowledgeBaseCaptureService {
  constructor(private readonly plugin: CodexForObsidianPlugin) {}

  async captureText(target: "inbox" | "raw-articles"): Promise<void> {
    if (target === "raw-articles") {
      const paths = await this.captureLink();
      if (paths.length) new Notice(`已写入 ${paths.join("，")}`);
      return;
    }
    const { textInputModal } = await import("../ui/modals");
    const value = await textInputModal(this.plugin.app, "记录知识库想法", "输入内容或链接");
    if (!value?.trim()) return;
    const paths = [await this.writeCollectedText(value.trim())];
    new Notice(`已写入 ${paths.join("，")}`);
  }

  async captureWeChatArticle(): Promise<string[]> {
    return this.captureLink();
  }

  async captureWebPage(): Promise<string[]> {
    return this.captureLink();
  }

  async captureLink(initialValue = "", feedback?: CaptureLinkFeedback): Promise<string[]> {
    const { captureLinkModal } = await import("../ui/capture-link-modal");
    return captureLinkModal(this.plugin.app, initialValue, ({ input, kind }) => this.captureRawArticleInput(input, kind), feedback);
  }

  async captureExternalFiles(files: StoredAttachment[]): Promise<string[]> {
    return this.copyFilesToRaw(files);
  }

  async captureChatInput(target: "inbox" | "raw-articles" | "raw-attachments", text: string, attachments: StoredAttachment[], feedback?: CaptureLinkFeedback): Promise<string[]> {
    if (attachments.length) return this.copyAttachmentsToRaw(attachments);
    const trimmed = text.trim();
    if (target === "inbox") return trimmed ? [await this.writeCollectedText(trimmed)] : [];
    return trimmed ? this.captureRawArticleInput(trimmed, undefined, feedback) : this.captureLink("", feedback);
  }

  private async copyCapturedFile(source: string, directory: string, fileName: string): Promise<string> {
    const extension = path.extname(fileName);
    const stem = path.basename(fileName, extension);
    for (let index = 1; ; index++) {
      const target = path.join(directory, `${stem}${index === 1 ? "" : `-${index}`}${extension}`);
      try { await fsp.copyFile(source, target, fsConstants.COPYFILE_EXCL); return target; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
  }

  private captureDirectory(vaultPath: string, child: string): string {
    const config = getKnowledgeFolderBindings(vaultPath);
    if (!config) return path.join(vaultPath, resolveKnowledgePath(vaultPath, "raw"), child);
    const binding = config.roles.raw;
    const approved = binding.allowedSubdirectories.includes(child) && (binding.allowedSubdirectoryRoots ?? binding.readPaths).includes(binding.writePath ?? "") ? child : "";
    return path.join(vaultPath, resolveKnowledgeRoleTarget(vaultPath, "raw", approved));
  }

  async captureActiveAttachment(): Promise<void> {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) {
      new Notice("没有可收集的当前文件");
      return;
    }
    const ext = path.extname(file.path).toLowerCase();
    if (!SUPPORTED_RAW_EXTENSIONS.has(ext) || [".md", ".markdown", ".txt"].includes(ext)) {
      new Notice("当前文件不是图片或 PDF");
      return;
    }
    const vaultPath = this.plugin.getVaultPath();
    const source = path.join(vaultPath, file.path);
    const targetDir = await this.collectionDirectory(vaultPath, collectionFileKind(file.path) === "images" ? "images" : "files");
    const target = await this.copyCapturedFile(source, targetDir, `${formatDateTimeForFile(new Date())}-${path.basename(file.path)}`);
    new Notice(`已收集到 ${normalizePath(path.relative(vaultPath, target))}`);
  }

  private async captureRawArticleInput(value: string, kind?: CaptureLinkKind, feedback?: CaptureLinkFeedback): Promise<string[]> {
    const url = extractFirstUrl(value);
    if (!url) throw new Error("收藏只支持网页和公众号链接");
    if (!kind) return this.captureLink(value, feedback);
    return kind === "wechat" ? this.captureWeChatUrl(url) : this.captureWebUrl(url, value);
  }

  private async writeCollectedText(value: string): Promise<string> {
    const vaultPath = this.plugin.getVaultPath();
    const now = new Date();
    const stamp = formatDateTimeForFile(now);
    const dir = path.join(vaultPath, getKnowledgeFolderBindings(vaultPath) ? resolveKnowledgeRoleTarget(vaultPath, "inbox") : resolveKnowledgePath(vaultPath, "inbox"));
    await fsp.mkdir(dir, { recursive: true });
    const fileName = `${stamp} 知识库想法.md`;
    const body = [
      "---",
      `created: ${now.toISOString()}`,
      "source: inbox",
      "---",
      "",
      value.trim(),
      ""
    ].join("\n");
    const absolute = path.join(dir, fileName);
    await fsp.writeFile(absolute, body, "utf8");
    return normalizePath(path.relative(vaultPath, absolute));
  }

  private async captureWeChatUrl(url: string): Promise<string[]> {
    const vaultPath = this.plugin.getVaultPath();
    const dest = await this.collectionDirectory(vaultPath, "wechat");
    return [await this.captureHtmlLikePage(url, dest, "微信公众号", "", "wechat")];
  }

  private async captureWebUrl(url: string, originalInput = ""): Promise<string[]> {
    const vaultPath = this.plugin.getVaultPath();
    const dest = await this.collectionDirectory(vaultPath, "web");
    return [await this.captureHtmlLikePage(url, dest, "web", originalInput, "web")];
  }

  private async collectionDirectory(vaultPath: string, kind: Exclude<KnowledgeCollectionKind, "answer" | "generation">): Promise<string> {
    const config = getKnowledgeFolderBindings(vaultPath);
    if (!config) {
      const legacy = this.captureDirectory(vaultPath, ({ web: "articles/网页收藏", wechat: "articles/微信公众号", files: "attachments", images: "attachments", fileText: "articles/文件收藏" })[kind]);
      await fsp.mkdir(legacy, { recursive: true });
      return legacy;
    }
    const relative = knowledgeCollectionDirectory(config, kind);
    if (!relative) throw new Error(`${KNOWLEDGE_COLLECTION_LABELS[kind]}收藏位置尚未选择或已失效，请到知识库 → Agent 产出物保存到重新选择。`);
    let current = await fsp.realpath(vaultPath);
    for (const segment of relative.split("/")) {
      current = path.join(current, segment);
      const stat = await fsp.lstat(current).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
      if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`${KNOWLEDGE_COLLECTION_LABELS[kind]}的原收藏目录已失效，请到知识库 → Agent 产出物保存到重新选择。`);
    }
    return current;
  }

  private async captureHtmlLikePage(url: string, dest: string, source: string, originalInput: string, kind: "web" | "wechat"): Promise<string> {
    const vaultPath = this.plugin.getVaultPath();
    const response = await requestUrl({
      url,
      method: "GET",
      headers: {
        "User-Agent": source === "微信公众号"
          ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.50"
          : "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/125 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
      }
    });
    const html = response.text;
    if (isHtmlVerificationBlocked(html)) {
      throw new Error(`${source}收藏失败：网页需要验证或登录，插件不会绕过验证。`);
    }
    const article = extractArticleMarkdown(html, url);
    const now = new Date();
    const title = article.title || source;
    const fileName = `${formatDateTimeForFile(now)} ${sanitizeWebCaptureFileName(title)}.md`;
    const absolute = path.join(dest, fileName);
    const body = [
      "---",
      `created: ${now.toISOString()}`,
      `source: ${source}`,
      `url: ${url}`,
      "---",
      "",
      `# ${title}`,
      "",
      `> 原文：${url}`,
      originalInput && originalInput.trim() !== url ? `> 收集说明：${originalInput.trim()}` : "",
      "",
      article.markdown || "正文提取失败，仅保留来源链接。",
      ""
    ].filter((line) => line !== "").join("\n");
    if (await this.collectionDirectory(vaultPath, kind) !== dest) throw new Error("收藏位置已更改，请重新收藏。");
    await fsp.writeFile(absolute, body, "utf8");
    return normalizePath(path.relative(vaultPath, absolute));
  }

  private async copyFilesToRaw(files: StoredAttachment[]): Promise<string[]> {
    const vaultPath = this.plugin.getVaultPath();
    const copied: string[] = [];
    const unsupported = files.find(file => !collectionFileKind(file.path));
    if (unsupported) throw new Error(`不支持收藏“${unsupported.name}”。请选择 PDF、Word DOCX、Markdown、TXT 或 PNG、JPG/JPEG、GIF、WebP 图片。`);
    for (const file of files) {
      const ext = path.extname(file.path).toLowerCase();
      const bindings = getKnowledgeFolderBindings(vaultPath);
      const kind = collectionFileKind(file.path) === "images" ? "images" : [".md", ".markdown", ".txt"].includes(ext) && bindings && Object.hasOwn(knowledgeCollectionTargets(bindings), "fileText") ? "fileText" : "files";
      const targetDir = await this.collectionDirectory(vaultPath, kind);
      const target = await this.copyCapturedFile(file.path, targetDir, `${formatDateTimeForFile(new Date())}-${path.basename(file.path)}`);
      copied.push(normalizePath(path.relative(vaultPath, target)));
    }
    if (!copied.length) throw new Error("请选择 PDF、Word、Markdown、文本或图片文件。");
    return copied;
  }

  async copyAttachmentsToRaw(attachments: StoredAttachment[]): Promise<string[]> {
    return attachments.length ? this.copyFilesToRaw(attachments) : [];
  }
}

function formatDateTimeForFile(date: Date): string {
  return `${formatDateForFile(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
