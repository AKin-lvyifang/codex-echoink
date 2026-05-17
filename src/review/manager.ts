import * as fsp from "fs/promises";
import * as path from "path";
import { Notice, normalizePath } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { ReviewReportKind, ReviewReportState } from "../settings/settings";
import {
  REVIEW_OUTPUT_DIR,
  buildReviewDocuments,
  collectAgentChatReviewEvidence,
  collectKnowledgeBaseReviewEvidence,
  type KnowledgeBaseDashboardEvidence,
  type KnowledgeBaseMaintenanceReportEvidence
} from "./report";
import { currentReviewRange, latestScheduledReviewRange, reviewRangeKey, shouldRunScheduledReview, type ReviewRange } from "./schedule";

export interface ReviewRunResult {
  status: "success" | "failed";
  markdownPath: string;
  htmlPath: string;
  summary: string;
  error?: string;
}

export class ReviewManager {
  private scheduleTimer: number | null = null;
  private running = false;

  constructor(private readonly plugin: CodexForObsidianPlugin) {}

  register(): void {
    this.plugin.addCommand({
      id: "review-run-knowledge-base-now",
      name: "复盘：生成知识库周报",
      callback: () => void this.runReview("knowledge-base")
    });
    this.plugin.addCommand({
      id: "review-run-agent-chat-now",
      name: "复盘：生成 Agent 对话周报",
      callback: () => void this.runReview("agent-chat")
    });
    this.plugin.addCommand({
      id: "review-open-latest-html",
      name: "复盘：打开最近 HTML 看板",
      callback: () => void this.openLatestHtml()
    });
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
  }

  async runReview(kind: ReviewReportKind, range: ReviewRange = currentReviewRange()): Promise<ReviewRunResult> {
    if (this.running) {
      new Notice("复盘周报正在生成");
      return {
        status: "failed",
        markdownPath: "",
        htmlPath: "",
        summary: "",
        error: "已有复盘任务正在运行"
      };
    }
    this.running = true;
    const state = this.stateForKind(kind);
    state.lastRunStatus = "running";
    state.lastError = "";
    await this.plugin.saveSettings(true);
    try {
      const evidence = kind === "knowledge-base"
        ? collectKnowledgeBaseReviewEvidence(this.plugin.settings, range, {
          dashboard: await this.readKnowledgeDashboardEvidence(),
          maintenanceReports: await this.readMaintenanceReports(range)
        })
        : collectAgentChatReviewEvidence(this.plugin.settings, range);
      const documents = buildReviewDocuments(kind, range, evidence);
      const outputDir = path.join(this.plugin.getVaultPath(), REVIEW_OUTPUT_DIR);
      await fsp.mkdir(outputDir, { recursive: true });
      const markdownPath = normalizePath(`${REVIEW_OUTPUT_DIR}/${documents.markdownFileName}`);
      const htmlPath = normalizePath(`${REVIEW_OUTPUT_DIR}/${documents.htmlFileName}`);
      await fsp.writeFile(path.join(this.plugin.getVaultPath(), markdownPath), documents.markdown, "utf8");
      await fsp.writeFile(path.join(this.plugin.getVaultPath(), htmlPath), documents.html, "utf8");
      state.lastRunAt = Date.now();
      state.lastRunStatus = "success";
      state.lastRangeKey = reviewRangeKey(range);
      state.lastMarkdownPath = markdownPath;
      state.lastHtmlPath = htmlPath;
      state.lastError = "";
      state.lastSummary = documents.summary.slice(0, 1000);
      await this.plugin.saveSettings(true);
      new Notice(`已生成${kindLabel(kind)}周报：${markdownPath}`);
      return { status: "success", markdownPath, htmlPath, summary: state.lastSummary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.lastRunAt = Date.now();
      state.lastRunStatus = "failed";
      state.lastError = message;
      await this.plugin.saveSettings(true);
      new Notice(`${kindLabel(kind)}周报生成失败：${message}`);
      return {
        status: "failed",
        markdownPath: state.lastMarkdownPath,
        htmlPath: state.lastHtmlPath,
        summary: "",
        error: message
      };
    } finally {
      this.running = false;
    }
  }

  async runScheduledIfDue(forceCatchUp = false): Promise<void> {
    const settings = this.plugin.settings.review;
    if (!settings.enabled || this.running) return;
    const now = new Date();
    const range = latestScheduledReviewRange(now, settings.scheduleTime);
    if (!range) return;
    const kinds: ReviewReportKind[] = [];
    if (settings.knowledgeBaseEnabled && shouldRunScheduledReview(settings, "knowledge-base", now)) kinds.push("knowledge-base");
    if (settings.agentChatEnabled && shouldRunScheduledReview(settings, "agent-chat", now)) kinds.push("agent-chat");
    if (!forceCatchUp && !kinds.length) return;
    for (const kind of kinds) {
      await this.runReview(kind, range);
    }
  }

  async openLatestHtml(kind?: ReviewReportKind): Promise<void> {
    const states = kind
      ? [this.stateForKind(kind)]
      : [this.plugin.settings.review.reports.knowledgeBase, this.plugin.settings.review.reports.agentChat]
        .filter((state) => state.lastHtmlPath)
        .sort((left, right) => right.lastRunAt - left.lastRunAt);
    const state = states[0];
    if (!state?.lastHtmlPath) {
      new Notice("还没有可打开的复盘 HTML 看板");
      return;
    }
    await this.plugin.openReviewHtmlPreview(state.lastHtmlPath);
  }

  private armSchedule(): void {
    if (this.scheduleTimer) window.clearInterval(this.scheduleTimer);
    this.scheduleTimer = window.setInterval(() => void this.runScheduledIfDue(), 60 * 1000);
    this.plugin.registerInterval(this.scheduleTimer);
  }

  private async runCatchUpIfNeeded(): Promise<void> {
    if (!this.plugin.settings.review.catchUpOnStartup) return;
    await this.runScheduledIfDue(true);
  }

  private stateForKind(kind: ReviewReportKind): ReviewReportState {
    return kind === "knowledge-base"
      ? this.plugin.settings.review.reports.knowledgeBase
      : this.plugin.settings.review.reports.agentChat;
  }

  private async readKnowledgeDashboardEvidence(): Promise<KnowledgeBaseDashboardEvidence> {
    const snapshot = await this.plugin.getKnowledgeBaseManager()?.getDashboardSnapshot().catch(() => null);
    if (!snapshot) return {};
    return {
      healthScore: snapshot.health.score,
      rawCount: snapshot.raw.fileCount,
      wikiCount: snapshot.wiki.fileCount,
      outputsCount: snapshot.outputs.fileCount,
      inboxCount: snapshot.inbox.fileCount,
      latestReportPath: snapshot.outputs.latestReportPath
    };
  }

  private async readMaintenanceReports(range: ReviewRange): Promise<KnowledgeBaseMaintenanceReportEvidence[]> {
    const outputsDir = path.join(this.plugin.getVaultPath(), "outputs");
    const entries = await fsp.readdir(outputsDir, { withFileTypes: true }).catch(() => []);
    const reports: Array<KnowledgeBaseMaintenanceReportEvidence & { mtime: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^kb-maintenance-\d{4}-\d{2}-\d{2}\.md$/.test(entry.name)) continue;
      const absolute = path.join(outputsDir, entry.name);
      const stat = await fsp.stat(absolute).catch(() => null);
      if (!stat || stat.mtimeMs < range.startAt || stat.mtimeMs > range.endAt + 24 * 60 * 60 * 1000) continue;
      const excerpt = (await fsp.readFile(absolute, "utf8").catch(() => "")).trim().slice(0, 1000);
      reports.push({
        path: normalizePath(`outputs/${entry.name}`),
        excerpt,
        mtime: stat.mtimeMs
      });
    }
    return reports
      .sort((left, right) => right.mtime - left.mtime)
      .slice(0, 5)
      .map(({ path, excerpt }) => ({ path, excerpt }));
  }
}

function kindLabel(kind: ReviewReportKind): string {
  return kind === "knowledge-base" ? "知识库" : "Agent 对话";
}
