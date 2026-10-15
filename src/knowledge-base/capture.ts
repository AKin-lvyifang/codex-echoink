import { constants as fsConstants } from "node:fs";
import { resolveKnowledgeRoleTarget, getKnowledgeFolderBindings } from "./root-paths";
import { resolveKnowledgePath } from "./root-paths";
import * as fsp from "fs/promises";
import * as path from "path";
import { Notice, normalizePath, requestUrl, TFile } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { StoredAttachment } from "../settings/settings";
import { SUPPORTED_RAW_EXTENSIONS } from "./discovery";
import { formatDateForFile, pad } from "./utils";
import {
  extractArticleMarkdown,
  extractFirstUrl,
  isHtmlVerificationBlocked,
  isWeChatUrl,
  sanitizeWebCaptureFileName,
  stripCollectPrefix
} from "./web-capture";

const KNOWLEDGE_FILE_CAPTURE_EXTENSIONS = new Set([".pdf", ".docx", ".md", ".markdown", ".txt"]);

export class KnowledgeBaseCaptureService {
  constructor(private readonly plugin: CodexForObsidianPlugin) {}

  async captureText(target: "inbox" | "raw-articles"): Promise<void> {
    const { textInputModal } = await import("../ui/modals");
    const value = await textInputModal(this.plugin.app, target === "inbox" ? "记录知识库想法" : "收集链接到 raw", "输入内容或链接");
    if (!value?.trim()) return;
    const paths = target === "raw-articles"
      ? await this.captureRawArticleInput(value.trim())
      : [await this.writeCollectedText(target, value.trim())];
    new Notice(`已写入 ${paths.join("，")}`);
  }

  async captureWeChatArticle(): Promise<string[]> {
    const { textInputModal } = await import("../ui/modals");
    const value = await textInputModal(this.plugin.app, "公众号收集", "粘贴 mp.weixin.qq.com 链接");
    if (!value?.trim()) return [];
    const url = extractFirstUrl(value);
    if (!url || !isWeChatUrl(url)) throw new Error("请输入微信公众号文章链接");
    return this.captureWeChatUrl(url);
  }

  async captureWebPage(): Promise<string[]> {
    const { textInputModal } = await import("../ui/modals");
    const value = await textInputModal(this.plugin.app, "网页收藏", "粘贴公开网页链接");
    if (!value?.trim()) return [];
    const url = extractFirstUrl(value);
    if (!url) throw new Error("请输入网页链接");
    return this.captureWebUrl(url);
  }

  async captureLink(): Promise<string[]> {
    const { textInputModal } = await import("../ui/modals");
    const value = await textInputModal(this.plugin.app, "收藏", "粘贴公众号或网页链接");
    if (!value?.trim()) return [];
    const url = extractFirstUrl(value);
    if (!url) throw new Error("请输入公众号或网页链接");
    if (isWeChatUrl(url)) return this.captureWeChatUrl(url);
    return this.captureWebUrl(url, value);
  }

  async captureExternalFiles(files: StoredAttachment[]): Promise<string[]> {
    return this.copyFilesToRaw(files);
  }

  async captureChatInput(target: "inbox" | "raw-articles" | "raw-attachments", text: string, attachments: StoredAttachment[]): Promise<string[]> {
    const paths: string[] = [];
    const copiedAttachments = await this.copyAttachmentsToRaw(attachments);
    paths.push(...copiedAttachments);
    const trimmed = text.trim();
    if (target === "raw-articles" && trimmed && !copiedAttachments.length) {
      paths.push(...await this.captureRawArticleInput(trimmed));
      return paths;
    }
    if (trimmed || copiedAttachments.length) {
      const textTarget = target === "inbox" && !copiedAttachments.length ? "inbox" : "raw-articles";
      const body = copiedAttachments.length
        ? [
          trimmed,
          "",
          "## 附件",
          ...copiedAttachments.map((item) => `- [[${item}]]`)
        ].join("\n").trim()
        : trimmed;
      if (body) paths.push(await this.writeCollectedText(textTarget, body));
    }
    return paths;
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
    const approved = config.roles.raw.allowedSubdirectories.includes(child) ? child : "";
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
    const targetDir = this.captureDirectory(vaultPath, "attachments");
    await fsp.mkdir(targetDir, { recursive: true });
    const target = await this.copyCapturedFile(source, targetDir, `${formatDateTimeForFile(new Date())}-${path.basename(file.path)}`);
    new Notice(`已收集到 ${normalizePath(path.relative(vaultPath, target))}`);
  }

  private async captureRawArticleInput(value: string): Promise<string[]> {
    const url = extractFirstUrl(value);
    if (!url) return [await this.writeCollectedText("raw-articles", stripCollectPrefix(value))];
    if (isWeChatUrl(url)) return this.captureWeChatUrl(url);
    return this.captureWebUrl(url, value);
  }

  private async writeCollectedText(target: "inbox" | "raw-articles", value: string): Promise<string> {
    const vaultPath = this.plugin.getVaultPath();
    const now = new Date();
    const stamp = formatDateTimeForFile(now);
    const dir = target === "inbox" ? path.join(vaultPath, getKnowledgeFolderBindings(vaultPath) ? resolveKnowledgeRoleTarget(vaultPath, "inbox") : resolveKnowledgePath(vaultPath, "inbox")) : this.captureDirectory(vaultPath, "articles/手动收集");
    await fsp.mkdir(dir, { recursive: true });
    const fileName = target === "inbox" ? `${stamp} 知识库想法.md` : `${stamp} 手动收集.md`;
    const body = [
      "---",
      `created: ${now.toISOString()}`,
      `source: ${target}`,
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
    const dest = this.captureDirectory(vaultPath, "articles/微信公众号");
    await fsp.mkdir(dest, { recursive: true });
    return [await this.captureHtmlLikePage(url, dest, "微信公众号")];
  }

  private async captureWebUrl(url: string, originalInput = ""): Promise<string[]> {
    const vaultPath = this.plugin.getVaultPath();
    const dest = this.captureDirectory(vaultPath, "articles/网页收藏");
    await fsp.mkdir(dest, { recursive: true });
    return [await this.captureHtmlLikePage(url, dest, "web", originalInput)];
  }

  private async captureHtmlLikePage(url: string, dest: string, source: string, originalInput = ""): Promise<string> {
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
    await fsp.writeFile(absolute, body, "utf8");
    return normalizePath(path.relative(vaultPath, absolute));
  }

  private async copyFilesToRaw(files: StoredAttachment[]): Promise<string[]> {
    const vaultPath = this.plugin.getVaultPath();
    const copied: string[] = [];
    for (const file of files) {
      const ext = path.extname(file.path).toLowerCase();
      if (!KNOWLEDGE_FILE_CAPTURE_EXTENSIONS.has(ext)) continue;
      const textLike = [".md", ".markdown", ".txt"].includes(ext);
      const targetDir = textLike
        ? this.captureDirectory(vaultPath, "articles/文件收藏")
        : this.captureDirectory(vaultPath, "attachments");
      await fsp.mkdir(targetDir, { recursive: true });
      const target = await this.copyCapturedFile(file.path, targetDir, `${formatDateTimeForFile(new Date())}-${path.basename(file.path)}`);
      copied.push(normalizePath(path.relative(vaultPath, target)));
    }
    if (!copied.length) throw new Error("请选择 PDF、DOCX、Markdown 或 TXT 文件。");
    return copied;
  }

  async copyAttachmentsToRaw(attachments: StoredAttachment[]): Promise<string[]> {
    if (!attachments.length) return [];
    const vaultPath = this.plugin.getVaultPath();
    const targetDir = this.captureDirectory(vaultPath, "attachments");
    await fsp.mkdir(targetDir, { recursive: true });
    const copied: string[] = [];
    for (const attachment of attachments) {
      const ext = path.extname(attachment.path).toLowerCase();
      if (!SUPPORTED_RAW_EXTENSIONS.has(ext) || [".md", ".markdown", ".txt"].includes(ext)) continue;
      const target = await this.copyCapturedFile(attachment.path, targetDir, `${formatDateTimeForFile(new Date())}-${path.basename(attachment.path)}`);
      copied.push(normalizePath(path.relative(vaultPath, target)));
    }
    return copied;
  }
}

function formatDateTimeForFile(date: Date): string {
  return `${formatDateForFile(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
