import type { KnowledgeBaseCommandUiMode, KnowledgeBaseRunResult, KnowledgeBaseSource, StructureNormalizationResult } from "./types";

export type KnowledgeBaseMessageUiPayload = KnowledgeBaseRunPayload | KnowledgeBaseMaintainReportPayload;

export interface KnowledgeBaseRunPayload {
  kind: "maintain-run";
  mode: KnowledgeBaseCommandUiMode;
  title: string;
  subtitle: string;
  icon: KnowledgeBaseCommandIcon;
  phases: KnowledgeBaseRunPhase[];
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
    phases: config.phases
  };
}

export function buildKnowledgeBaseMaintainReportPayload(mode: KnowledgeBaseCommandUiMode, result: KnowledgeBaseRunResult): KnowledgeBaseMaintainReportPayload {
  const structureCount = structureOperationCount(result.structure);
  const externalRawCount = result.externalRawAdditions?.length ?? 0;
  return {
    kind: "maintain-report",
    mode,
    status: result.status,
    title: reportTitle(mode, result.status),
    reportPath: result.reportPath,
    careItems: buildCareItems(mode, result, structureCount, externalRawCount),
    sections: buildReportSections(mode, result, structureCount, externalRawCount)
  };
}

function buildCareItems(mode: KnowledgeBaseCommandUiMode, result: KnowledgeBaseRunResult, structureCount: number, externalRawCount: number): KnowledgeBaseMaintainCareItem[] {
  if (result.status === "failed") {
    return [{ tone: "warning", text: `需要关注。${result.error || "知识库任务失败。"}` }];
  }
  if (result.status === "canceled") {
    return [{ tone: "info", text: "已取消。本轮不会继续改动知识库。" }];
  }
  if (mode === "lint") {
    return [
      { tone: "info", text: "先看真正影响后续整理的问题。" },
      { tone: "success", text: "本轮只做体检，没有改动知识库正文。" }
    ];
  }
  if (mode === "calibrate") {
    const calibration = result.calibration;
    const reviewCount = calibration?.review.length ?? 0;
    const changedCount = calibration?.changed.length ?? 0;
    return [
      reviewCount || changedCount
        ? { tone: "warning", text: `需要关注 ${reviewCount + changedCount} 个 raw 状态。` }
        : { tone: "success", text: "raw 状态已校准，无需手动补标。" },
      { tone: "info", text: "本轮只校准托管属性和状态记录，不改 raw 正文。" }
    ];
  }
  if (mode === "outputs") {
    const count = result.processedSources.length;
    return [
      count
        ? { tone: "success", text: `outputs 已归档 ${count} 项。` }
        : { tone: "info", text: "没有可直接归档的 outputs。" },
      { tone: "info", text: "半成品和去向不确定的内容已保留原位。" }
    ];
  }
  if (mode === "inbox") {
    const count = result.processedSources.length;
    return [
      count
        ? { tone: "success", text: `inbox 已分流 ${count} 项。` }
        : { tone: "info", text: "没有可直接分流的 inbox 条目。" },
      { tone: "info", text: "去向不确定的条目不会被强行入库。" }
    ];
  }
  const items: KnowledgeBaseMaintainCareItem[] = [];
  if (result.processedSources.length) items.push({ tone: "success", text: `本轮消化 ${result.processedSources.length} 篇。` });
  else items.push({ tone: "success", text: "不需要补救。没有需要你手动处理的文件。" });
  if (structureCount) items.push({ tone: "info", text: `结构整理 ${structureCount} 项。` });
  if (externalRawCount) items.push({ tone: "warning", text: `发现新增 raw ${externalRawCount} 个。` });
  return items;
}

function buildReportSections(mode: KnowledgeBaseCommandUiMode, result: KnowledgeBaseRunResult, structureCount: number, externalRawCount: number): KnowledgeBaseMaintainReportSection[] {
  if (mode === "lint") return buildLintSections();
  if (mode === "calibrate") return buildCalibrationSections(result);
  if (mode === "outputs") return buildOutputsSections(result);
  if (mode === "inbox") return buildInboxSections(result);
  return [
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
}

function buildLintSections(): KnowledgeBaseMaintainReportSection[] {
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
      count: 0,
      emptyText: "未发现可展示的命名或结构偏差。",
      items: []
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
    description: evidencePaths.length ? `已确认来源证据：${evidencePaths.slice(0, 2).join("，")}。` : "已确认有对应知识证据，并登记状态。",
    tone: "success"
  };
}

function structureToReportItems(structure?: StructureNormalizationResult): KnowledgeBaseMaintainReportSectionItem[] {
  if (!structure) return [];
  const moves = structure.moves.map((item) => ({
    title: item.to,
    description: `移动：${item.from} -> ${item.to}。${item.reason}`.trim(),
    tone: "info" as const
  }));
  const links = structure.updatedLinks.map((item) => ({
    title: item.path,
    description: `更新引用 ${item.replacements} 处。`,
    tone: "info" as const
  }));
  const skipped = structure.skipped.map((item) => ({
    title: item.from,
    description: item.to ? `跳过：${item.to}。${item.reason}` : `跳过：${item.reason}`,
    tone: "warning" as const
  }));
  return [...moves, ...links, ...skipped];
}

function structureOperationCount(structure?: StructureNormalizationResult): number {
  if (!structure) return 0;
  return structure.moves.length + structure.updatedLinks.reduce((sum, item) => sum + item.replacements, 0) + structure.skipped.length;
}

function reportTitle(mode: KnowledgeBaseCommandUiMode, status: KnowledgeBaseRunResult["status"]): string {
  const label = commandUiConfig(mode).noun;
  if (status === "failed") return `知识库${label}失败`;
  if (status === "canceled") return `知识库${label}已取消`;
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
