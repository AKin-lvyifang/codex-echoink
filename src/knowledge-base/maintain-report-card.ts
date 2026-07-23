import type { AgentBackendKind } from "../agent/types";
import type {
  KnowledgeBaseCommandUiMode,
  KnowledgeBaseRunCompletion,
  KnowledgeBaseRunPerformance,
  KnowledgeBaseRunResult,
  KnowledgeBaseRunWarning,
  KnowledgeBaseSource,
  KnowledgeRunAttemptRecord,
  KnowledgeWorkflowEvent,
  StructureNormalizationResult
} from "./types";

export type KnowledgeBaseMessageUiPayload = KnowledgeBaseRunPayload | KnowledgeBaseMaintainReportPayload;

export interface KnowledgeBaseRunPayload {
  kind: "maintain-run";
  mode: KnowledgeBaseCommandUiMode;
  title: string;
  subtitle: string;
  icon: KnowledgeBaseCommandIcon;
  phases: KnowledgeBaseRunPhase[];
  events?: KnowledgeWorkflowEvent[];
}

export interface KnowledgeBaseRunPhase {
  id: "prepare" | "digest" | "organize" | "report" | "complete";
  label: string;
  icon: KnowledgeBaseCommandIcon;
  motion: "scan" | "check" | "work" | "report" | "complete";
}

export interface KnowledgeBaseMaintainReportPayload {
  kind: "maintain-report";
  mode: KnowledgeBaseCommandUiMode;
  status: KnowledgeBaseRunResult["status"];
  runId?: string;
  backend?: AgentBackendKind;
  selectedBackend?: AgentBackendKind;
  winnerBackend?: AgentBackendKind | null;
  terminalPhase?: KnowledgeBaseRunResult["terminalPhase"];
  commitState?: KnowledgeBaseRunResult["commitState"];
  failureCode?: string | null;
  completion?: KnowledgeBaseRunCompletion;
  attemptCount?: number;
  attempts?: KnowledgeRunAttemptRecord[];
  pendingSourceCount?: number;
  warnings?: KnowledgeBaseRunWarning[];
  performance?: KnowledgeBaseRunPerformance;
  title: string;
  reportPath: string;
  careItems: KnowledgeBaseMaintainCareItem[];
  sections: KnowledgeBaseMaintainReportSection[];
}

export interface KnowledgeBaseMaintainCareItem {
  tone: "success" | "warning" | "info";
  text: string;
}

export interface KnowledgeBaseMaintainReportSection {
  id: string;
  title: string;
  count: number;
  emptyText: string;
  items: KnowledgeBaseMaintainReportSectionItem[];
}

export interface KnowledgeBaseMaintainReportSectionItem {
  title: string;
  path?: string;
  description: string;
  tone?: "success" | "warning" | "info";
}

export type KnowledgeBaseCommandIcon =
  | "archive"
  | "badge-check"
  | "book-open"
  | "bot"
  | "check"
  | "check-circle"
  | "clipboard-check"
  | "database"
  | "file-pen"
  | "folder-down"
  | "gauge"
  | "inbox"
  | "network"
  | "route"
  | "search"
  | "shield-check"
  | "tag";

interface KnowledgeBaseCommandUiConfig {
  title: string;
  noun: string;
  icon: KnowledgeBaseCommandIcon;
  phases: KnowledgeBaseRunPhase[];
}

export function knowledgeBaseRunModeForCommandIntent(intent: string): KnowledgeBaseCommandUiMode | null {
  if (intent === "maintain" || intent === "lint" || intent === "reingest") return intent;
  if (intent === "calibrate") return "calibrate";
  if (intent === "process-outputs") return "outputs";
  if (intent === "process-inbox") return "inbox";
  return null;
}

export function buildKnowledgeBaseRunPayload(mode: KnowledgeBaseCommandUiMode): KnowledgeBaseRunPayload {
  const config = commandUiConfig(mode);
  return {
    kind: "maintain-run",
    mode,
    title: config.title,
    subtitle: "阶段进度见下方",
    icon: config.icon,
    phases: config.phases,
    events: [{
      type: "workflow.started",
      status: "running",
      message: "等待真实阶段事件",
      createdAt: Date.now()
    }]
  };
}

export function buildKnowledgeBaseMaintainReportPayload(mode: KnowledgeBaseCommandUiMode, result: KnowledgeBaseRunResult): KnowledgeBaseMaintainReportPayload {
  const structureCount = structureOperationCount(result.structure);
  const externalRawCount = result.externalRawAdditions?.length ?? 0;
  const attempts = result.attempts?.length ? [...result.attempts] : [];
  const runId = maintenanceResultRunId(result);
  const backend = maintenanceResultBackend(result, attempts);
  const hasAttempts = Object.prototype.hasOwnProperty.call(result, "attempts");
  const hasWinnerBackend = Object.prototype.hasOwnProperty.call(
    result,
    "winnerBackend"
  );
  const hasFailureCode = Object.prototype.hasOwnProperty.call(
    result,
    "failureCode"
  );
  return {
    kind: "maintain-report",
    mode,
    status: result.status,
    ...(runId ? { runId } : {}),
    ...(backend ? { backend } : {}),
    ...(result.selectedBackend
      ? { selectedBackend: result.selectedBackend }
      : {}),
    ...(hasWinnerBackend
      ? { winnerBackend: result.winnerBackend ?? null }
      : {}),
    ...(result.terminalPhase
      ? { terminalPhase: result.terminalPhase }
      : {}),
    ...(result.commitState
      ? { commitState: result.commitState }
      : {}),
    ...(hasFailureCode
      ? { failureCode: result.failureCode ?? null }
      : {}),
    ...(result.completion ? { completion: result.completion } : {}),
    ...(hasAttempts ? { attemptCount: attempts.length, attempts } : {}),
    ...(result.pendingSources?.length ? { pendingSourceCount: result.pendingSources.length } : {}),
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    ...(result.performance ? { performance: result.performance } : {}),
    title: reportTitle(mode, result),
    reportPath: result.reportPath,
    careItems: buildCareItems(mode, result, structureCount, externalRawCount),
    sections: buildReportSections(mode, result, structureCount, externalRawCount)
  };
}

export function buildKnowledgeBaseFallbackReportPayload(
  mode: KnowledgeBaseCommandUiMode,
  status: KnowledgeBaseRunResult["status"],
  message: string,
  reportPath = ""
): KnowledgeBaseMaintainReportPayload {
  const compactMessage = message.trim().replace(/\s+/g, " ").slice(0, 280);
  const payload = buildKnowledgeBaseMaintainReportPayload(mode, {
    status,
    reportPath,
    summary: "",
    processedSources: [],
    ...(status === "success" || !compactMessage ? {} : { error: compactMessage })
  });
  return {
    ...payload,
    careItems: status === "success"
      ? [{ tone: "info", text: "任务已完成，但未收到结构化执行明细。" }]
      : payload.careItems,
    sections: []
  };
}

function maintenanceResultRunId(result: KnowledgeBaseRunResult): string | undefined {
  if (result.workflowRunId?.trim()) return result.workflowRunId.trim();
  const value = (result as KnowledgeBaseRunResult & { runId?: unknown }).runId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function maintenanceResultBackend(
  result: KnowledgeBaseRunResult,
  attempts: KnowledgeRunAttemptRecord[]
): AgentBackendKind | undefined {
  if (Object.prototype.hasOwnProperty.call(result, "winnerBackend")) {
    return result.winnerBackend ?? undefined;
  }
  const explicit = (result as KnowledgeBaseRunResult & { backend?: unknown }).backend;
  if (explicit === "codex-cli" || explicit === "opencode" || explicit === "hermes") return explicit;
  const completed = [...attempts].reverse().find((attempt) => attempt.terminal?.status === "completed");
  return completed?.backend ?? attempts.at(-1)?.backend;
}

function buildCareItems(mode: KnowledgeBaseCommandUiMode, result: KnowledgeBaseRunResult, structureCount: number, externalRawCount: number): KnowledgeBaseMaintainCareItem[] {
  if (result.status === "failed") {
    return [{ tone: "warning", text: `需要关注。${result.error || "知识库任务失败。"}` }];
  }
  if (result.status === "canceled") {
    return [{ tone: "info", text: "已取消。本轮不会继续改动知识库。" }];
  }
  const outcomeItems = buildOutcomeCareItems(result);
  if (mode === "lint") {
    return [
      ...outcomeItems,
      { tone: "info", text: "先看真正影响后续整理的问题。" },
      { tone: "success", text: "本轮只做体检，没有改动知识库正文。" }
    ];
  }
  if (mode === "calibrate") {
    const calibration = result.calibration;
    const reviewCount = calibration?.review.length ?? 0;
    const changedCount = calibration?.changed.length ?? 0;
    return [
      ...outcomeItems,
      reviewCount || changedCount
        ? { tone: "warning", text: `需要关注 ${reviewCount + changedCount} 个 raw 状态。` }
        : { tone: "success", text: "raw 状态已校准，无需手动补标。" },
      { tone: "info", text: "本轮只校准托管属性和状态记录，不改 raw 正文。" }
    ];
  }
  if (mode === "outputs") {
    const count = result.processedSources.length;
    return [
      ...outcomeItems,
      count
        ? { tone: "success", text: `outputs 已归档 ${count} 项。` }
        : { tone: "info", text: "没有可直接归档的 outputs。" },
      { tone: "info", text: "半成品和去向不确定的内容已保留原位。" }
    ];
  }
  if (mode === "inbox") {
    const count = result.processedSources.length;
    return [
      ...outcomeItems,
      count
        ? { tone: "success", text: `inbox 已分流 ${count} 项。` }
        : { tone: "info", text: "没有可直接分流的 inbox 条目。" },
      { tone: "info", text: "去向不确定的条目不会被强行入库。" }
    ];
  }
  const items: KnowledgeBaseMaintainCareItem[] = [...outcomeItems];
  if (result.processedSources.length) {
    items.push({ tone: "success", text: `本轮消化 ${result.processedSources.length} 篇。` });
  } else if (result.completion !== "partial" && result.completion !== "noop") {
    items.push({ tone: "success", text: "不需要补救。没有需要你手动处理的文件。" });
  }
  if (structureCount) items.push({ tone: "info", text: `结构整理 ${structureCount} 项。` });
  if (externalRawCount) items.push({ tone: "warning", text: `发现新增 raw ${externalRawCount} 个。` });
  return items;
}

function buildOutcomeCareItems(result: KnowledgeBaseRunResult): KnowledgeBaseMaintainCareItem[] {
  const items: KnowledgeBaseMaintainCareItem[] = [];
  if (result.completion === "partial") {
    const pending = result.pendingSources?.length ?? 0;
    items.push({
      tone: "warning",
      text: pending
        ? `本轮部分完成，${pending} 个来源已安全留待下轮。`
        : "本轮部分完成，未提交的来源已安全留待下轮。"
    });
  } else if (result.completion === "recovered") {
    const attempts = result.attempts?.length ?? 0;
    items.push({
      tone: "success",
      text: attempts > 1 ? `本轮经过自动恢复后完成，共尝试 ${attempts} 个 Agent。` : "本轮经过自动恢复后完成。"
    });
  } else if (result.completion === "noop") {
    items.push({ tone: "info", text: "本轮没有待消化来源，未调用 Agent；Harness 已完成状态核对。" });
  }
  for (const warning of (result.warnings ?? []).slice(0, 3)) {
    items.push({ tone: "warning", text: warning.message });
  }
  return items;
}

function buildReportSections(mode: KnowledgeBaseCommandUiMode, result: KnowledgeBaseRunResult, structureCount: number, externalRawCount: number): KnowledgeBaseMaintainReportSection[] {
  const sections = mode === "lint"
    ? buildLintSections(result)
    : mode === "calibrate"
      ? buildCalibrationSections(result)
      : mode === "outputs"
        ? buildOutputsSections(result)
        : mode === "inbox"
          ? buildInboxSections(result)
          : [
            {
              id: "digested",
              title: "本轮消化",
              count: result.processedSources.length,
              emptyText: "没有新的 Raw 需要消化。",
              items: result.processedSources.map((source) => sourceToReportItem(source, result.digestEvidencePaths?.[source.relativePath]))
            },
            {
              id: "external-raw",
              title: "新增 raw",
              count: externalRawCount,
              emptyText: "没有发现额外新增的 Raw 文件。",
              items: (result.externalRawAdditions ?? []).map((item) => ({
                title: item,
                path: item,
                description: "维护过程中发现的新 Raw；已保留在 raw/，留到下一次处理。",
                tone: "info" as const
              }))
            },
            {
              id: "structure",
              title: "结构整理",
              count: structureCount,
              emptyText: "没有需要展示的结构整理。",
              items: structureToReportItems(result.structure)
            }
          ];
  return [...sections, ...buildOutcomeSections(result)];
}

function buildOutcomeSections(result: KnowledgeBaseRunResult): KnowledgeBaseMaintainReportSection[] {
  const sections: KnowledgeBaseMaintainReportSection[] = [];
  if (result.pendingSources?.length) {
    sections.push({
      id: "pending-sources",
      title: "留待下轮",
      count: result.pendingSources.length,
      emptyText: "没有留待下轮的来源。",
      items: result.pendingSources.map((source) => ({
        title: source,
        path: source,
        description: "本轮未达到提交条件，已保持原状并留待下轮。",
        tone: "warning" as const
      }))
    });
  }
  if (result.warnings?.length) {
    sections.push({
      id: "warnings",
      title: "运行提醒",
      count: result.warnings.length,
      emptyText: "没有运行提醒。",
      items: result.warnings.map((warning) => ({
        title: warning.id,
        description: warning.message,
        tone: "warning" as const
      }))
    });
  }
  return sections;
}

function buildLintSections(result: KnowledgeBaseRunResult): KnowledgeBaseMaintainReportSection[] {
  const structureItems = lintStructureDriftItems(result.structure);
  return [
    {
      id: "broken-links",
      title: "断链与引用异常",
      count: 0,
      emptyText: "未发现可展示的断链或引用异常。",
      items: []
    },
    {
      id: "structure-drift",
      title: "命名与结构偏差",
      count: structureItems.length,
      emptyText: "未发现可展示的命名或结构偏差。",
      items: structureItems
    },
    {
      id: "quick-fixes",
      title: "可顺手修",
      count: 0,
      emptyText: "没有可顺手修的项目。",
      items: []
    }
  ];
}

function lintStructureDriftItems(structure?: StructureNormalizationResult): KnowledgeBaseMaintainReportSectionItem[] {
  if (!structure) return [];
  const rootNotes = structure.remainingRootNotes.map((item) => ({
    title: item,
    path: item,
    description: "根目录散落笔记，建议归入 wiki/、projects/ 或 inbox/。",
    tone: "warning" as const
  }));
  const chineseDirs = structure.remainingChineseDirs.map((item) => ({
    title: item,
    description: "目录命名仍有中文路径，建议按知识库规则统一。",
    tone: "warning" as const
  }));
  const risks = structure.risks.map((item) => ({
    title: "结构风险",
    description: item,
    tone: "warning" as const
  }));
  return [...structureToReportItems(structure), ...rootNotes, ...chineseDirs, ...risks];
}

function buildCalibrationSections(result: KnowledgeBaseRunResult): KnowledgeBaseMaintainReportSection[] {
  const calibration = result.calibration;
  const marked = calibration?.marked ?? result.processedSources;
  const review = calibration?.review ?? [];
  const changed = calibration?.changed ?? [];
  return [
    {
      id: "raw-marked",
      title: "已登记",
      count: marked.length,
      emptyText: "没有新增已登记 raw。",
      items: marked.map((source) => sourceToCalibrationItem(source, calibration?.evidencePaths[source.relativePath]))
    },
    {
      id: "raw-review",
      title: "待复核",
      count: review.length,
      emptyText: "没有需要手动复核的 raw。",
      items: review.map((source) => ({
        title: source.relativePath,
        path: source.relativePath,
        description: "状态或证据不完整，建议先补来源再确认状态。",
        tone: "warning" as const
      }))
    },
    {
      id: "raw-changed",
      title: "内容变更",
      count: changed.length,
      emptyText: "没有发现 Raw 正文变更。",
      items: changed.map((source) => ({
        title: source.relativePath,
        path: source.relativePath,
        description: "Raw 正文已变化，需要重新提炼后再登记状态。",
        tone: "warning" as const
      }))
    }
  ];
}

function buildOutputsSections(result: KnowledgeBaseRunResult): KnowledgeBaseMaintainReportSection[] {
  return [
    {
      id: "outputs-archived",
      title: "已归档到知识库",
      count: result.processedSources.length,
      emptyText: "没有可直接归档的条目。",
      items: result.processedSources.map((source) => sourceToReportItem(source))
    },
    {
      id: "outputs-needs-home",
      title: "待补归属",
      count: 0,
      emptyText: "没有待补归属的条目。",
      items: []
    },
    {
      id: "outputs-kept",
      title: "暂留原位",
      count: 0,
      emptyText: "没有暂留原位的条目。",
      items: []
    }
  ];
}

function buildInboxSections(result: KnowledgeBaseRunResult): KnowledgeBaseMaintainReportSection[] {
  return [
    {
      id: "inbox-raw",
      title: "已进 raw",
      count: result.processedSources.length,
      emptyText: "没有 raw 分流条目。",
      items: result.processedSources.map((source) => sourceToReportItem(source))
    },
    {
      id: "inbox-targets",
      title: "已直达目标区",
      count: 0,
      emptyText: "没有直达目标区的条目。",
      items: []
    },
    {
      id: "inbox-needs-decision",
      title: "需要你决定",
      count: 0,
      emptyText: "没有需要你决定的条目。",
      items: []
    }
  ];
}

function sourceToReportItem(source: KnowledgeBaseSource, evidencePaths: string[] = []): KnowledgeBaseMaintainReportSectionItem {
  const evidence = evidencePaths.slice(0, 2).join("，");
  return {
    title: source.relativePath,
    path: source.relativePath,
    description: source.changed
      ? evidence
        ? `已写入 ${evidence}。`
        : "已完成提炼，并登记来源证据。"
      : evidence
        ? `已确认已有知识承载：${evidence}。`
        : "已核验为无需重复消化。",
    tone: source.changed ? "success" : "info"
  };
}

function sourceToCalibrationItem(source: KnowledgeBaseSource, evidencePaths: string[] = []): KnowledgeBaseMaintainReportSectionItem {
  return {
    title: source.relativePath,
    path: source.relativePath,
    description: evidencePaths.length ? `已确认来源证据：${evidencePaths.slice(0, 2).join("，")}。` : "已确认有对应知识证据，并登记状态。",
    tone: "success"
  };
}

function structureToReportItems(structure?: StructureNormalizationResult): KnowledgeBaseMaintainReportSectionItem[] {
  if (!structure) return [];
  const moves = structure.moves.map((item) => ({
    title: item.to,
    path: item.to,
    description: `移动：${item.from} -> ${item.to}。${item.reason}`.trim(),
    tone: "info" as const
  }));
  const links = structure.updatedLinks.map((item) => ({
    title: item.path,
    path: item.path,
    description: `更新引用 ${item.replacements} 处。`,
    tone: "info" as const
  }));
  const skipped = structure.skipped.map((item) => ({
    title: item.from,
    path: item.from,
    description: item.to ? `跳过：${item.to}。${item.reason}` : `跳过：${item.reason}`,
    tone: "warning" as const
  }));
  return [...moves, ...links, ...skipped];
}

function structureOperationCount(structure?: StructureNormalizationResult): number {
  if (!structure) return 0;
  return structure.moves.length + structure.updatedLinks.reduce((sum, item) => sum + item.replacements, 0) + structure.skipped.length;
}

function reportTitle(mode: KnowledgeBaseCommandUiMode, result: KnowledgeBaseRunResult): string {
  const label = commandUiConfig(mode).noun;
  if (result.status === "failed") return `知识库${label}失败`;
  if (result.status === "canceled") return `知识库${label}已取消`;
  if (result.completion === "partial") return `知识库${label}部分完成`;
  if (result.completion === "recovered") return `知识库${label}已恢复完成`;
  if (result.completion === "noop") return `知识库${label}完成（无新来源）`;
  if (mode === "calibrate") return "raw 状态已校准";
  if (mode === "lint") return "体检完成";
  if (mode === "outputs") return "outputs 已归档";
  if (mode === "inbox") return "inbox 已分流";
  return `知识库${label}完成`;
}

function commandUiConfig(mode: KnowledgeBaseCommandUiMode): KnowledgeBaseCommandUiConfig {
  if (mode === "lint") {
    return {
      title: "正在体检知识库",
      noun: "体检",
      icon: "shield-check",
      phases: [
        phase("prepare", "扫库", "search", "scan"),
        phase("digest", "找断点", "shield-check", "check"),
        phase("organize", "对规则", "gauge", "check"),
        phase("report", "出建议", "clipboard-check", "report"),
        phase("complete", "收口", "check-circle", "complete")
      ]
    };
  }
  if (mode === "calibrate") {
    return {
      title: "正在校准 raw 状态",
      noun: "raw 状态校准",
      icon: "gauge",
      phases: [
        phase("prepare", "找 raw", "search", "scan"),
        phase("digest", "验状态", "gauge", "check"),
        phase("organize", "对来源", "database", "work"),
        phase("report", "调标记", "badge-check", "report"),
        phase("complete", "锁定", "check-circle", "complete")
      ]
    };
  }
  if (mode === "outputs") {
    return {
      title: "正在处理 outputs",
      noun: "outputs 处理",
      icon: "archive",
      phases: [
        phase("prepare", "扫描", "search", "scan"),
        phase("digest", "归类", "tag", "check"),
        phase("organize", "整理", "archive", "work"),
        phase("report", "报告", "clipboard-check", "report"),
        phase("complete", "完成", "check-circle", "complete")
      ]
    };
  }
  if (mode === "inbox") {
    return {
      title: "正在处理 inbox",
      noun: "inbox 处理",
      icon: "inbox",
      phases: [
        phase("prepare", "扫描", "inbox", "scan"),
        phase("digest", "判别", "search", "check"),
        phase("organize", "分流", "route", "work"),
        phase("report", "报告", "clipboard-check", "report"),
        phase("complete", "完成", "check-circle", "complete")
      ]
    };
  }
  if (mode === "reingest") {
    return {
      title: "正在重新提炼知识库",
      noun: "重新提炼",
      icon: "file-pen",
      phases: [
        phase("prepare", "准备", "book-open", "scan"),
        phase("digest", "重提炼", "file-pen", "work"),
        phase("organize", "整理", "network", "work"),
        phase("report", "报告", "clipboard-check", "report"),
        phase("complete", "完成", "check-circle", "complete")
      ]
    };
  }
  return {
    title: "正在维护知识库",
    noun: "维护",
    icon: "bot",
    phases: [
      phase("prepare", "准备", "book-open", "scan"),
      phase("digest", "消化", "file-pen", "work"),
      phase("organize", "整理", "network", "work"),
      phase("report", "报告", "clipboard-check", "report"),
      phase("complete", "完成", "check-circle", "complete")
    ]
  };
}

function phase(id: KnowledgeBaseRunPhase["id"], label: string, icon: KnowledgeBaseCommandIcon, motion: KnowledgeBaseRunPhase["motion"]): KnowledgeBaseRunPhase {
  return { id, label, icon, motion };
}
