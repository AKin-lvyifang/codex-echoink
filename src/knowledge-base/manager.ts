import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { Notice, normalizePath, requestUrl, TFile } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { AgentInputModality, AgentModelInfo, AgentPromptPart } from "../agent/types";
import { OpenCodeBackend } from "../core/opencode-backend";
import { ensureOpenCodeModelSupportsFiles, requiredModalityForMime } from "../core/opencode-models";
import type { StoredAttachment } from "../settings/settings";
import type { CodexNotification, UserInput } from "../types/app-server";
import { knowledgeBaseHelpText, parseKnowledgeBaseCommand } from "./commands";
import { extractKnowledgeBaseNotificationIds, routeKnowledgeBaseCodexNotification } from "./codex-route";
import { readKnowledgeBaseReportExcerpt, recoveredLintReportSummary } from "./report";
import { SUPPORTED_RAW_EXTENSIONS, discoverKnowledgeBaseSources } from "./discovery";
import { buildKnowledgeBasePrompt } from "./prompt";
import type { KnowledgeBaseDiscovery, KnowledgeBaseRunMode, KnowledgeBaseRunResult, KnowledgeBaseSource } from "./types";

type CodexKbWaiter = {
  threadId: string;
  turnId: string;
  itemIds: Set<string>;
  text: string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: number;
};

export interface KnowledgeBaseChatResult {
  status: "success" | "failed";
  message: string;
}

const MAX_ATTACHED_SOURCES = 20;
const CODEX_KB_TIMEOUT_MS = 10 * 60 * 1000;
const KNOWLEDGE_FILE_CAPTURE_EXTENSIONS = new Set([".pdf", ".docx", ".md", ".markdown", ".txt"]);
const URL_PATTERN = /https?:\/\/[^\s<>"')]+/i;

export class KnowledgeBaseManager {
  private running = false;
  private scheduleTimer: number | null = null;
  private codexWaiter: CodexKbWaiter | null = null;
  private activeCodexRun: { threadId: string; turnId: string } | null = null;
  private activeOpenCode: { backend: OpenCodeBackend; sessionId: string } | null = null;

  constructor(private readonly plugin: CodexForObsidianPlugin) {}

  register(): void {
    this.plugin.addCommand({
      id: "knowledge-base-maintain-now",
      name: "知识库：立即维护",
      callback: () => void this.runMaintenance("maintain")
    });
    this.plugin.addCommand({
      id: "knowledge-base-lint-now",
      name: "知识库：只体检",
      callback: () => void this.runMaintenance("lint")
    });
    this.plugin.addCommand({
      id: "knowledge-base-capture-idea",
      name: "知识库：记录想法到 inbox",
      callback: () => void this.captureText("inbox")
    });
    this.plugin.addCommand({
      id: "knowledge-base-capture-link",
      name: "知识库：收集链接到 raw",
      callback: () => void this.captureText("raw-articles")
    });
    this.plugin.addCommand({
      id: "knowledge-base-capture-active-attachment",
      name: "知识库：收集当前图片或 PDF",
      callback: () => void this.captureActiveAttachment()
    });
    this.plugin.addCommand({
      id: "knowledge-base-cancel",
      name: "知识库：取消当前任务",
      callback: () => void this.cancelMaintenance()
    });
    this.plugin.addRibbonIcon("library", "知识库管理", () => void this.plugin.activateKnowledgeBaseChannel());
    this.plugin.app.workspace.onLayoutReady(() => {
      this.armSchedule();
      void this.runCatchUpIfNeeded();
    });
  }

  unload(): void {
    if (this.scheduleTimer) {
      window.clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    if (this.codexWaiter) {
      window.clearTimeout(this.codexWaiter.timer);
      this.codexWaiter.reject(new Error("知识库任务已取消"));
      this.codexWaiter = null;
    }
    this.activeCodexRun = null;
    this.activeOpenCode = null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async cancelMaintenance(): Promise<void> {
    const codexRun = this.activeCodexRun;
    const openCodeRun = this.activeOpenCode;
    if (!this.running && !this.codexWaiter && !codexRun && !openCodeRun) {
      new Notice("当前没有知识库任务");
      return;
    }
    if (this.codexWaiter) {
      window.clearTimeout(this.codexWaiter.timer);
      this.codexWaiter.reject(new Error("知识库任务已取消"));
      this.codexWaiter = null;
    }
    if (codexRun?.threadId && codexRun.turnId && this.plugin.codex) {
      await this.plugin.codex.interruptTurn(codexRun.threadId, codexRun.turnId).catch(() => undefined);
    }
    if (openCodeRun?.sessionId) {
      await openCodeRun.backend.abort(openCodeRun.sessionId).catch(() => undefined);
    }
    this.activeCodexRun = null;
    this.activeOpenCode = null;
    this.running = false;
    this.plugin.settings.knowledgeBase.lastRunStatus = "canceled";
    this.plugin.settings.knowledgeBase.lastError = "用户取消";
    await this.plugin.saveSettings(true);
    new Notice("已取消知识库任务");
  }

  async testOpenCodeConnection(): Promise<void> {
    const backend = new OpenCodeBackend({
      ...this.plugin.settings.opencode,
      vaultPath: this.plugin.getVaultPath()
    });
    try {
      await backend.connect();
      const models = await backend.listModels();
      const selected = selectOpenCodeModel(
        models,
        this.plugin.settings.opencode.providerId,
        this.plugin.settings.opencode.modelId,
        ["text"]
      );
      if (selected) {
        this.plugin.settings.opencode.providerId = selected.providerId;
        this.plugin.settings.opencode.modelId = selected.modelId;
        this.plugin.settings.opencode.textEnabled = selected.inputModalities.includes("text");
        this.plugin.settings.opencode.imageEnabled = selected.inputModalities.includes("image");
        this.plugin.settings.opencode.pdfEnabled = selected.inputModalities.includes("pdf");
      }
      this.plugin.settings.opencode.lastConnectedAt = Date.now();
      this.plugin.settings.opencode.lastError = "";
      await this.plugin.saveSettings(true);
      new Notice(`OpenCode 已连接，读取到 ${models.length} 个模型`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.plugin.settings.opencode.lastError = message;
      await this.plugin.saveSettings(true);
      new Notice(`OpenCode 连接失败：${message}`);
    } finally {
      await backend.disconnect();
    }
  }

  async handleUserMessage(text: string, attachments: StoredAttachment[] = []): Promise<KnowledgeBaseChatResult> {
    const command = parseKnowledgeBaseCommand(text, attachments.length);
    try {
      if (command.intent === "help") {
        return { status: "success", message: knowledgeBaseHelpText() };
      }
      if (command.intent === "cancel") {
        await this.cancelMaintenance();
        return { status: "success", message: "已请求取消当前知识库任务。" };
      }
      if (command.intent === "lint" || command.intent === "maintain" || command.intent === "reingest" || command.intent === "process-outputs" || command.intent === "process-inbox") {
        const mode = command.intent === "process-inbox" ? "inbox" : command.intent === "process-outputs" ? "outputs" : command.intent;
        const result = await this.runMaintenance(mode, text);
        if (result.status === "success") {
          return {
            status: "success",
            message: [
              `知识库${labelForRunMode(mode)}完成。`,
              result.reportPath ? `报告：${result.reportPath}` : "",
              result.summary ? `\n${result.summary}` : ""
            ].filter(Boolean).join("\n")
          };
        }
        return {
          status: "failed",
          message: [
            `知识库${labelForRunMode(mode)}失败：${result.error || "未知错误"}`,
            this.formatFailureContext(result.reportPath)
          ].filter(Boolean).join("\n")
        };
      }
      if (command.intent === "journal") {
        const paths = await this.captureChatInput("journal", text, attachments);
        return {
          status: "success",
          message: paths.length ? `已写入日记：\n${paths.map((item) => `- ${item}`).join("\n")}` : "没有可写入日记的内容。"
        };
      }
      const target = command.target ?? (attachments.length ? "raw-attachments" : "inbox");
      const paths = await this.captureChatInput(target, text, attachments);
      return {
        status: "success",
        message: paths.length ? `已收集到：\n${paths.map((item) => `- ${item}`).join("\n")}` : "没有可收集的内容。"
      };
    } catch (error) {
      return {
        status: "failed",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async runMaintenance(mode: KnowledgeBaseRunMode = "maintain", userRequest = ""): Promise<KnowledgeBaseRunResult> {
    if (this.running) {
      new Notice("知识库维护正在运行");
      return {
        status: "failed",
        reportPath: this.plugin.settings.knowledgeBase.lastReportPath,
        summary: "",
        processedSources: [],
        error: "已有任务正在运行"
      };
    }
    this.running = true;
    const settings = this.plugin.settings.knowledgeBase;
    settings.lastRunStatus = "running";
    settings.lastError = "";
    await this.plugin.saveSettings(true);

    const startedAt = Date.now();
    const rawBefore = await snapshotRawFiles(this.plugin.getVaultPath());
    let discovery: KnowledgeBaseDiscovery | null = null;
    try {
      discovery = await discoverKnowledgeBaseSources(this.plugin.getVaultPath(), settings.processedSources);
      await ensureKnowledgeBaseFolders(this.plugin.getVaultPath());
      const rules = await this.resolveRulesFile();
      if (rules.useCustomRulesFile && !rules.exists) {
        throw new Error(`知识库操作指南文件不存在：${rules.relativePath}。请在设置里修正路径。`);
      }
      const promptSources = selectSourcesForRunMode(mode, discovery);
      const prompt = buildKnowledgeBasePrompt({
        vaultPath: this.plugin.getVaultPath(),
        mode,
        userRequest,
        reportPath: discovery.reportPath,
        sources: promptSources,
        rulesFilePath: rules.relativePath,
        rulesFileExists: rules.exists,
        useCustomRulesFile: rules.useCustomRulesFile,
        hasRawIndex: await exists(path.join(this.plugin.getVaultPath(), "raw", "index.md")),
        hasWikiIndex: await exists(path.join(this.plugin.getVaultPath(), "wiki", "index.md")),
        hasTracker: await exists(discovery.trackerPath)
      });

      const backend = this.resolveKnowledgeBackend();
      const sources = promptSources.slice(0, MAX_ATTACHED_SOURCES);
      const output = backend === "opencode"
        ? await this.runOpenCodeKnowledgeTask(prompt, sources)
        : await this.runCodexKnowledgeTask(prompt, sources);

      const rawAfter = await snapshotRawFiles(this.plugin.getVaultPath());
      const rawChanges = diffRawSnapshot(rawBefore, rawAfter);
      if (rawChanges.length) {
        throw new Error(`知识库任务试图修改 raw/：${rawChanges.slice(0, 5).join("，")}`);
      }

      if (mode === "maintain" || mode === "reingest") {
        for (const source of discovery.changedSources) {
          settings.processedSources[source.relativePath] = {
            path: source.relativePath,
            size: source.size,
            mtime: source.mtime,
            digestedAt: startedAt
          };
        }
        await writeKnowledgeBaseTracker(this.plugin.getVaultPath(), settings.processedSources, startedAt);
      }
      await ensureFallbackReport(this.plugin.getVaultPath(), discovery.reportPath, {
        mode,
        output,
        sources: discovery.changedSources,
        startedAt
      });
      settings.lastRunAt = Date.now();
      settings.lastRunStatus = "success";
      settings.lastReportPath = discovery.reportPath;
      settings.lastSummary = output.trim().slice(0, 1000) || `知识库${labelForRunMode(mode)}完成`;
      await this.plugin.saveSettings(true);
      new Notice(`知识库${labelForRunMode(mode)}完成`);
      return {
        status: "success",
        reportPath: discovery.reportPath,
        summary: settings.lastSummary,
        processedSources: discovery.changedSources
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (mode === "lint" && discovery?.reportPath) {
        const rawAfter = await snapshotRawFiles(this.plugin.getVaultPath()).catch(() => rawBefore);
        const rawChanges = diffRawSnapshot(rawBefore, rawAfter);
        const reportExcerpt = rawChanges.length ? null : await readKnowledgeBaseReportExcerpt(this.plugin.getVaultPath(), discovery.reportPath);
        if (reportExcerpt) {
          settings.lastRunAt = Date.now();
          settings.lastRunStatus = "success";
          settings.lastReportPath = discovery.reportPath;
          settings.lastError = "";
          settings.lastSummary = recoveredLintReportSummary(discovery.reportPath);
          await this.plugin.saveSettings(true);
          new Notice("知识库体检完成，Codex 状态有警告");
          return {
            status: "success",
            reportPath: discovery.reportPath,
            summary: settings.lastSummary,
            processedSources: []
          };
        }
      }
      settings.lastRunAt = Date.now();
      settings.lastRunStatus = "failed";
      settings.lastError = message;
      if (discovery?.reportPath) settings.lastReportPath = discovery.reportPath;
      await this.plugin.saveSettings(true);
      new Notice(`知识库${labelForRunMode(mode)}失败：${message}`);
      return {
        status: "failed",
        reportPath: discovery?.reportPath ?? "",
        summary: "",
        processedSources: discovery?.changedSources ?? [],
        error: message
      };
    } finally {
      this.activeCodexRun = null;
      this.activeOpenCode = null;
      this.running = false;
    }
  }

  handleCodexNotification(notification: CodexNotification): boolean {
    const waiter = this.codexWaiter;
    if (!waiter) return false;
    const { method, params } = notification;
    const ids = extractKnowledgeBaseNotificationIds(params);
    const route = routeKnowledgeBaseCodexNotification(method, params, {
      threadId: waiter.threadId,
      turnId: waiter.turnId,
      itemIds: waiter.itemIds
    });
    if (!route.swallow) return false;
    if (method === "turn/started" && ids.turnId) waiter.turnId = ids.turnId;
    if (route.rememberItemId) waiter.itemIds.add(route.rememberItemId);
    if (ids.itemId && ids.turnId && ids.turnId === waiter.turnId) waiter.itemIds.add(ids.itemId);
    if (route.collectAssistantDelta) waiter.text += params?.delta ?? "";
    if (method === "turn/completed") {
      window.clearTimeout(waiter.timer);
      this.codexWaiter = null;
      if (params?.turn?.status === "failed") waiter.reject(new Error("Codex 知识库任务失败"));
      else waiter.resolve(waiter.text);
    }
    if (method === "error") {
      window.clearTimeout(waiter.timer);
      this.codexWaiter = null;
      waiter.reject(new Error(params?.message ?? "Codex 知识库任务失败"));
    }
    return true;
  }

  private async runCodexKnowledgeTask(prompt: string, sources: KnowledgeBaseSource[]): Promise<string> {
    const status = await this.plugin.ensureCodexConnected(false, { silent: true });
    if (!status.connected || !this.plugin.codex) throw new Error(status.errors[0] || "Codex 未连接");
    const model = this.plugin.settings.defaultModel || status.models[0]?.model || "gpt-5.5";
    const writableRoots = [
      path.join(this.plugin.getVaultPath(), "wiki"),
      path.join(this.plugin.getVaultPath(), "outputs"),
      path.join(this.plugin.getVaultPath(), "raw", "index.md")
    ];
    const started = await this.plugin.codex.startThread({
      model,
      reasoning: "high",
      serviceTier: this.plugin.settings.defaultServiceTier,
      permission: "workspace-write",
      mode: "agent",
      mcpEnabled: this.plugin.settings.mcpEnabled,
      persistExtendedHistory: false,
      requestTimeoutMs: 60000,
      writableRoots
    });
    const result = new Promise<string>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.codexWaiter = null;
        reject(new Error("Codex 知识库任务超时"));
      }, CODEX_KB_TIMEOUT_MS);
      this.codexWaiter = { threadId: started.threadId, turnId: "", itemIds: new Set<string>(), text: "", resolve, reject, timer };
    });
    const turnId = await this.plugin.codex.startTurn(started.threadId, buildCodexKnowledgeInput(prompt, sources), {
      model,
      reasoning: "high",
      serviceTier: this.plugin.settings.defaultServiceTier,
      permission: "workspace-write",
      mode: "agent",
      mcpEnabled: this.plugin.settings.mcpEnabled,
      persistExtendedHistory: false,
      requestTimeoutMs: 60000,
      writableRoots
    });
    this.activeCodexRun = { threadId: started.threadId, turnId };
    if (this.codexWaiter) this.codexWaiter.turnId = turnId;
    return result;
  }

  private async runOpenCodeKnowledgeTask(prompt: string, sources: KnowledgeBaseSource[]): Promise<string> {
    const backend = new OpenCodeBackend({
      ...this.plugin.settings.opencode,
      vaultPath: this.plugin.getVaultPath()
    });
    try {
      await backend.connect();
      const info = backend.getConnectionInfo();
      this.plugin.settings.opencode.lastConnectedAt = Date.now();
      this.plugin.settings.opencode.lastError = "";
      const models = await backend.listModels();
      const parts = buildOpenCodeKnowledgeParts(prompt, sources);
      const selectedModel = selectOpenCodeModel(models, this.plugin.settings.opencode.providerId, this.plugin.settings.opencode.modelId, requiredModalities(parts));
      ensureOpenCodeModelSupportsFiles(selectedModel, parts);
      if (selectedModel) {
        this.plugin.settings.opencode.providerId = selectedModel.providerId;
        this.plugin.settings.opencode.modelId = selectedModel.modelId;
        this.plugin.settings.opencode.textEnabled = selectedModel.inputModalities.includes("text");
        this.plugin.settings.opencode.imageEnabled = selectedModel.inputModalities.includes("image");
        this.plugin.settings.opencode.pdfEnabled = selectedModel.inputModalities.includes("pdf");
      }
      await this.plugin.saveSettings();
      const session = await backend.startSession({
        title: "Obsidian 知识库维护",
        agent: this.plugin.settings.opencode.agent,
        ...(selectedModel ? { model: { providerId: selectedModel.providerId, modelId: selectedModel.modelId } } : {})
      });
      this.activeOpenCode = { backend, sessionId: session.sessionId };
      return await backend.sendPrompt({
        sessionId: session.sessionId,
        parts,
        agent: this.plugin.settings.opencode.agent,
        ...(selectedModel ? { model: { providerId: selectedModel.providerId, modelId: selectedModel.modelId } } : {}),
        tools: {
          write: true,
          edit: true,
          read: true,
          bash: false
        }
      });
    } catch (error) {
      this.plugin.settings.opencode.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await backend.disconnect();
    }
  }

  private resolveKnowledgeBackend(): "codex-cli" | "opencode" {
    const configured = this.plugin.settings.knowledgeBase.backend;
    return configured === "default" ? this.plugin.settings.agentBackend : configured;
  }

  private formatFailureContext(reportPath = ""): string {
    const backend = this.resolveKnowledgeBackend();
    const opencode = this.plugin.settings.opencode;
    const kb = this.plugin.settings.knowledgeBase;
    return [
      `后端：${backend}`,
      backend === "opencode" && opencode.providerId && opencode.modelId ? `模型：${opencode.providerId}/${opencode.modelId}` : "",
      `规则文件：${kb.useCustomRulesFile ? kb.rulesFilePath : "AGENTS.md"}`,
      reportPath ? `报告：${reportPath}` : ""
    ].filter(Boolean).join("\n");
  }

  private async resolveRulesFile(): Promise<{ relativePath: string; absolutePath: string; exists: boolean; useCustomRulesFile: boolean }> {
    const settings = this.plugin.settings.knowledgeBase;
    const relativePath = normalizeRulesPath(settings.useCustomRulesFile ? settings.rulesFilePath : "AGENTS.md");
    const absolutePath = path.join(this.plugin.getVaultPath(), relativePath);
    return {
      relativePath,
      absolutePath,
      exists: await exists(absolutePath),
      useCustomRulesFile: settings.useCustomRulesFile
    };
  }

  private armSchedule(): void {
    if (this.scheduleTimer) window.clearInterval(this.scheduleTimer);
    this.scheduleTimer = window.setInterval(() => void this.runScheduledIfDue(), 60 * 1000);
    this.plugin.registerInterval(this.scheduleTimer);
  }

  private async runCatchUpIfNeeded(): Promise<void> {
    if (!this.plugin.settings.knowledgeBase.catchUpOnStartup) return;
    await this.runScheduledIfDue(true);
  }

  private async runScheduledIfDue(forceCatchUp = false): Promise<void> {
    const settings = this.plugin.settings.knowledgeBase;
    if (!settings.enabled || !settings.scheduleEnabled || this.running) return;
    const now = new Date();
    const [hour, minute] = settings.scheduleTime.split(":").map((item) => Number(item));
    const scheduled = new Date(now);
    scheduled.setHours(hour, minute, 0, 0);
    const last = settings.lastRunAt ? new Date(settings.lastRunAt) : null;
    const alreadyRanToday = Boolean(last && last.toDateString() === now.toDateString());
    if (alreadyRanToday) return;
    if (forceCatchUp || now >= scheduled) await this.runMaintenance("maintain");
  }

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

  async captureExternalFiles(files: StoredAttachment[]): Promise<string[]> {
    return this.copyFilesToRaw(files);
  }

  private async captureChatInput(target: "inbox" | "raw-articles" | "raw-attachments" | "journal", text: string, attachments: StoredAttachment[]): Promise<string[]> {
    const paths: string[] = [];
    const copiedAttachments = await this.copyAttachmentsToRaw(attachments);
    paths.push(...copiedAttachments);
    const trimmed = text.trim();
    if (target === "journal" && trimmed) {
      paths.push(await this.writeJournalEntry(trimmed));
      return paths;
    }
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
    const dir = target === "inbox" ? path.join(vaultPath, "inbox") : path.join(vaultPath, "raw", "articles", "手动收集");
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

  private async writeJournalEntry(value: string): Promise<string> {
    const journalText = stripJournalPrefix(value).trim();
    if (!journalText) throw new Error("请在“写日记：”后面输入日记内容。");
    const vaultPath = this.plugin.getVaultPath();
    const now = new Date();
    const date = formatDateForTitle(now);
    const dir = path.join(vaultPath, "journal", "daily");
    await fsp.mkdir(dir, { recursive: true });
    const absolute = path.join(dir, `${date}.md`);
    const entry = [
      "",
      `## ${now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
      "",
      journalText,
      ""
    ].join("\n");
    const header = [
      "---",
      `created: ${now.toISOString()}`,
      "source: knowledge-base-channel",
      "---",
      "",
      `# ${date}`,
      ""
    ].join("\n");
    const existsAlready = await exists(absolute);
    if (existsAlready) await fsp.appendFile(absolute, entry, "utf8");
    else await fsp.writeFile(absolute, `${header}${entry}`, "utf8");
    return normalizePath(path.relative(vaultPath, absolute));
  }

  private async captureWeChatUrl(url: string): Promise<string[]> {
    const vaultPath = this.plugin.getVaultPath();
    const dest = path.join(vaultPath, "raw", "articles", "微信公众号");
    await fsp.mkdir(dest, { recursive: true });
    const skillScript = path.join(process.env.HOME || "", ".codex", "skills", "wechat-article-to-obsidian-raw", "scripts", "wechat_capture.mjs");
    if (await exists(skillScript)) {
      try {
        const { stdout } = await execFilePromise("node", [skillScript, url, "--dest", dest], {
          maxBuffer: 30 * 1024 * 1024
        });
        const parsed = JSON.parse(stdout.trim());
        if (parsed?.notePath) return [normalizePath(path.relative(vaultPath, parsed.notePath))];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/verification|captcha|环境异常|验证/i.test(message)) throw new Error(`公众号收集失败：微信验证拦截。${message}`);
      }
    }
    return [await this.captureHtmlLikePage(url, dest, "微信公众号")];
  }

  private async captureWebUrl(url: string, originalInput = ""): Promise<string[]> {
    const vaultPath = this.plugin.getVaultPath();
    const dest = path.join(vaultPath, "raw", "articles", "网页收藏");
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
    if (/环境异常|wappoc_appmsgcaptcha|完成验证后即可继续访问|captcha/i.test(html)) {
      throw new Error(`${source}收藏失败：网页需要验证或登录，插件不会绕过验证。`);
    }
    const article = extractArticleMarkdown(html, url);
    const now = new Date();
    const title = article.title || source;
    const fileName = `${formatDateTimeForFile(now)} ${sanitizeFileName(title)}.md`;
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
        ? path.join(vaultPath, "raw", "articles", "文件收藏")
        : path.join(vaultPath, "raw", "attachments");
      await fsp.mkdir(targetDir, { recursive: true });
      const target = path.join(targetDir, `${formatDateTimeForFile(new Date())}-${path.basename(file.path)}`);
      await fsp.copyFile(file.path, target);
      copied.push(normalizePath(path.relative(vaultPath, target)));
    }
    if (!copied.length) throw new Error("请选择 PDF、DOCX、Markdown 或 TXT 文件。");
    return copied;
  }

  private async copyAttachmentsToRaw(attachments: StoredAttachment[]): Promise<string[]> {
    if (!attachments.length) return [];
    const vaultPath = this.plugin.getVaultPath();
    const targetDir = path.join(vaultPath, "raw", "attachments");
    await fsp.mkdir(targetDir, { recursive: true });
    const copied: string[] = [];
    for (const attachment of attachments) {
      const ext = path.extname(attachment.path).toLowerCase();
      if (!SUPPORTED_RAW_EXTENSIONS.has(ext) || [".md", ".markdown", ".txt"].includes(ext)) continue;
      const target = path.join(targetDir, `${formatDateTimeForFile(new Date())}-${path.basename(attachment.path)}`);
      await fsp.copyFile(attachment.path, target);
      copied.push(normalizePath(path.relative(vaultPath, target)));
    }
    return copied;
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
    const targetDir = path.join(vaultPath, "raw", "attachments");
    await fsp.mkdir(targetDir, { recursive: true });
    const target = path.join(targetDir, `${formatDateTimeForFile(new Date())}-${path.basename(file.path)}`);
    await fsp.copyFile(source, target);
    new Notice(`已收集到 ${normalizePath(path.relative(vaultPath, target))}`);
  }
}

function buildCodexKnowledgeInput(prompt: string, sources: KnowledgeBaseSource[]): UserInput[] {
  const input: UserInput[] = [{ type: "text", text: prompt, text_elements: [] }];
  for (const source of sources.slice(0, MAX_ATTACHED_SOURCES)) {
    if (source.modality === "image") {
      input.push({ type: "localImage", path: source.absolutePath });
    } else {
      input.push({ type: "mention", name: path.basename(source.absolutePath), path: source.absolutePath });
    }
  }
  return input;
}

function buildOpenCodeKnowledgeParts(prompt: string, sources: KnowledgeBaseSource[]): AgentPromptPart[] {
  return [
    { type: "text", text: prompt },
    ...sources.slice(0, MAX_ATTACHED_SOURCES).map((source): AgentPromptPart => ({
      type: "file",
      path: source.absolutePath,
      filename: path.basename(source.absolutePath),
      mime: source.mime
    }))
  ];
}

function requiredModalities(parts: AgentPromptPart[]): AgentInputModality[] {
  const modalities = new Set<AgentInputModality>(["text"]);
  for (const part of parts) {
    if (part.type === "file") modalities.add(requiredModalityForMime(part.mime));
  }
  return Array.from(modalities);
}

function selectOpenCodeModel(models: AgentModelInfo[], providerId: string, modelId: string, required: AgentInputModality[]): AgentModelInfo | null {
  const configured = models.find((model) => model.providerId === providerId && model.modelId === modelId);
  if (configured) return configured;
  return models.find((model) => required.every((modality) => model.inputModalities.includes(modality))) ?? models[0] ?? null;
}

async function ensureKnowledgeBaseFolders(vaultPath: string): Promise<void> {
  await fsp.mkdir(path.join(vaultPath, "outputs"), { recursive: true });
  await fsp.mkdir(path.join(vaultPath, "wiki"), { recursive: true });
}

async function ensureFallbackReport(vaultPath: string, reportPath: string, input: { mode: KnowledgeBaseRunMode; output: string; sources: KnowledgeBaseSource[]; startedAt: number }): Promise<void> {
  const absolute = path.join(vaultPath, reportPath);
  if (await exists(absolute)) return;
  const lines = [
    "---",
    `created: ${new Date(input.startedAt).toISOString()}`,
    "source: obsidian-codex",
    "---",
    "",
    `# 知识库${labelForRunMode(input.mode)}报告 — ${formatDateForTitle(new Date(input.startedAt))}`,
    "",
    "## 一眼结论",
    input.output.trim() || "任务已完成，但 Agent 未返回摘要。",
    "",
    "## 本轮来源",
    ...(input.sources.length ? input.sources.map((source) => `- [[${source.relativePath}]]`) : ["- 无新增或变更 raw 文件"]),
    ""
  ];
  await fsp.writeFile(absolute, lines.join("\n"), "utf8");
}

async function writeKnowledgeBaseTracker(vaultPath: string, processed: Record<string, { path: string; size: number; mtime: number; digestedAt: number }>, updatedAt: number): Promise<void> {
  const tracker = path.join(vaultPath, "outputs", ".ingest-tracker.md");
  await fsp.mkdir(path.dirname(tracker), { recursive: true });
  const markerStart = "<!-- obsidian-codex-kb:start -->";
  const markerEnd = "<!-- obsidian-codex-kb:end -->";
  const current = await fsp.readFile(tracker, "utf8").catch(() => "---\nupdated: \n---\n\n# Ingest Tracker\n");
  const entries = Object.values(processed)
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((item) => `- \`${item.path}\` | size=${item.size} | mtime=${Math.round(item.mtime)} | digested=${new Date(item.digestedAt).toISOString()}`);
  const block = [
    markerStart,
    "",
    `## Obsidian Codex 处理记录（${new Date(updatedAt).toISOString()}）`,
    "",
    ...(entries.length ? entries : ["- 暂无"]),
    "",
    markerEnd
  ].join("\n");
  const pattern = new RegExp(`${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}`);
  const next = pattern.test(current) ? current.replace(pattern, block) : `${current.trim()}\n\n${block}\n`;
  await fsp.writeFile(tracker, next, "utf8");
}

function selectSourcesForRunMode(mode: KnowledgeBaseRunMode, discovery: KnowledgeBaseDiscovery): KnowledgeBaseSource[] {
  if (mode === "lint" || mode === "inbox" || mode === "outputs") return [];
  if (mode === "reingest") {
    const changed = discovery.changedSources;
    if (changed.length) return changed;
    return [...discovery.sources].sort((left, right) => right.mtime - left.mtime).slice(0, MAX_ATTACHED_SOURCES);
  }
  return discovery.changedSources;
}

function labelForRunMode(mode: KnowledgeBaseRunMode): string {
  if (mode === "lint") return "体检";
  if (mode === "reingest") return "重新提炼";
  if (mode === "outputs") return "outputs 处理";
  if (mode === "inbox") return "收件箱处理";
  return "维护";
}

function normalizeRulesPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((part) => part && part !== "." && part !== "..").join("/") || "AGENTS.md";
}

function extractFirstUrl(value: string): string | null {
  return value.match(URL_PATTERN)?.[0] ?? null;
}

function isWeChatUrl(value: string): boolean {
  try {
    return new URL(value).hostname === "mp.weixin.qq.com";
  } catch {
    return false;
  }
}

function stripCollectPrefix(value: string): string {
  return value.replace(/^(收集|收藏|剪藏|保存到\s*raw|网页收藏|公众号收集)[:：\s]*/i, "").trim();
}

function stripJournalPrefix(value: string): string {
  return value.replace(/^(\/journal|\/daily|\/diary|\/日记|写日记|记日记|日报|journal)[:：\s]*/i, "").trim();
}

function extractArticleMarkdown(html: string, url: string): { title: string; markdown: string } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  for (const selector of ["script", "style", "noscript", "svg", "iframe"]) {
    for (const node of Array.from(doc.querySelectorAll(selector))) node.remove();
  }
  const title = cleanInlineText(
    doc.querySelector("meta[property='og:title']")?.getAttribute("content")
    || doc.querySelector("title")?.textContent
    || new URL(url).hostname
  );
  const content = doc.querySelector("#js_content") || doc.querySelector("article") || doc.querySelector("main") || doc.body;
  const markdown = content ? domNodeToMarkdown(content).replace(/\n{3,}/g, "\n\n").trim() : "";
  return { title, markdown };
}

function domNodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return cleanTextNode(node.textContent ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const children = Array.from(el.childNodes).map(domNodeToMarkdown).join("");
  if (tag === "br") return "\n";
  if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag.slice(1)))} ${cleanInlineText(children)}\n\n`;
  if (tag === "p" || tag === "section" || tag === "div" || tag === "article") return children.trim() ? `\n\n${children.trim()}\n\n` : "";
  if (tag === "li") return `\n- ${children.trim()}`;
  if (tag === "blockquote") return children.trim().split("\n").map((line) => `> ${line.trim()}`).join("\n");
  if (tag === "a") {
    const href = el.getAttribute("href");
    const text = cleanInlineText(children) || href || "";
    return href ? `[${text}](${href})` : text;
  }
  if (tag === "img") {
    const src = el.getAttribute("data-src") || el.getAttribute("src");
    const alt = el.getAttribute("alt") || "image";
    return src ? `\n\n![${alt}](${src})\n\n` : "";
  }
  if (tag === "pre" || tag === "code") return `\n\n\`\`\`\n${el.textContent?.trim() ?? ""}\n\`\`\`\n\n`;
  return children;
}

function cleanTextNode(value: string): string {
  return value.replace(/\s+/g, " ");
}

function cleanInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sanitizeFileName(value: string): string {
  return cleanInlineText(value).replace(/[\\/:*?"<>|#\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "未命名资料";
}

function execFilePromise(command: string, args: string[], options: { maxBuffer: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const message = stderr || error.message;
        reject(new Error(message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function snapshotRawFiles(vaultPath: string): Promise<Map<string, string>> {
  const rawDir = path.join(vaultPath, "raw");
  const files = await walkFiles(rawDir).catch(() => []);
  const snapshot = new Map<string, string>();
  for (const file of files) {
    const stat = await fsp.stat(file);
    snapshot.set(normalizePath(path.relative(vaultPath, file)), `${stat.size}:${Math.round(stat.mtimeMs)}`);
  }
  return snapshot;
}

function diffRawSnapshot(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [file, value] of after) {
    if (before.get(file) !== value) changed.push(file);
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changed.push(file);
  }
  return changed.filter((file) => file !== "raw/index.md");
}

async function walkFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walkFiles(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

async function exists(filePath: string): Promise<boolean> {
  return fsp.access(filePath, fs.constants.F_OK).then(() => true, () => false);
}

function formatDateForFile(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDateForTitle(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDateTimeForFile(date: Date): string {
  return `${formatDateForFile(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
