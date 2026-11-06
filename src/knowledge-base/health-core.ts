import type { KnowledgeBaseDashboardHealth, KnowledgeBaseDashboardHealthScoreReason, KnowledgeBaseDashboardHealthStatus } from "./dashboard";
import type { KnowledgeBaseHealthHistoryEntry, KnowledgeBaseMaintenanceHistoryEntry, KnowledgeBaseSettings } from "../settings/settings";

export interface KnowledgeStructureHealthInput {
  mappedFolders?: boolean; bindingIssues?: string[]; readFailed: boolean; limited: boolean;
  settings: Pick<KnowledgeBaseSettings, "folderBindings" | "healthHistory" | "initialization">;
  maintenanceHistory: KnowledgeBaseMaintenanceHistoryEntry[];
  rawExists: boolean; wikiExists: boolean; wikiIndexExists: boolean; trackerExists: boolean;
  rawDigestStatus: { calibration: number };
  structure?: { total: number; broken: number; oneWay: number; isolated: number };
}
const HEALTH_SCORE_THRESHOLD_TEXT = "85+ 健康，60-84 风险，低于 60 异常；raw、wiki 或 Tracker 缺失各扣 24 分且覆盖分数阈值，直接显示异常。";
const HEALTH_SCORE_CHECK_NOTE = "原结构分再扣链接问题：死链每条 2 分、最多 20；单向相关每条 1 分、最多 10；孤立页占通用 Wiki 的比例 × 20，四舍五入、最多 20。已选不再提示的不扣，内容问题不扣分。";
const CRITICAL_HEALTH_PENALTY = 24;
const RISK_HEALTH_PENALTY = 2;

export function buildKnowledgeStructureHealth(input: KnowledgeStructureHealthInput): KnowledgeBaseDashboardHealth {
  const critical: string[] = [];
  const risk: string[] = [];
  const scoreReasons: KnowledgeBaseDashboardHealthScoreReason[] = [];
  const addReason = (
    severity: "critical" | "risk",
    reason: string,
    label: string,
    count: number,
    explanation: string,
    extraPenalty = 0
  ) => {
    if (severity === "critical") critical.push(reason);
    else risk.push(reason);
    scoreReasons.push({
      label,
      count,
      penalty: (severity === "critical" ? CRITICAL_HEALTH_PENALTY : RISK_HEALTH_PENALTY) + extraPenalty,
      explanation
    });
  };

  // Mapped roles already report each unavailable position through bindingIssues.
  if (!input.mappedFolders) {
    if (!input.rawExists) addReason("critical", "资料来源位置失效", "资料来源位置失效", 1, "已绑定的原始来源区不可用。");
    if (!input.wikiExists) addReason("critical", "知识成果位置失效", "知识成果位置失效", 1, "已绑定的知识区不可用。");
    if (!input.trackerExists) addReason("critical", "tracker 缺失", "tracker 缺失", 1, "说明来源消化登记无法确认。");
  }
  for (const issue of input.bindingIssues ?? []) addReason("critical", issue, issue, 1, "已启用的用途位置不可用，请重新选择。");

  const history = normalizeHealthHistory(input.settings.healthHistory ?? []);
  const latestCheckAt = latestHealthEntry(history.filter((entry) => entry.status === "success"))?.at ?? 0;
  if (input.rawDigestStatus.calibration > 0) {
    addReason("risk", `Raw 状态待校准 ${input.rawDigestStatus.calibration} 个`, "Raw 状态待校准", input.rawDigestStatus.calibration,
      "1–20 项合计扣 4 分，超过 20 项合计扣 10 分；历史记录显示可能已提炼，但缺少可信机器标记。", input.rawDigestStatus.calibration > 20 ? 8 : 2);
  }
  if (input.structure) {
    const { total, broken, oneWay, isolated } = input.structure;
    for (const [label, count, penalty, explanation] of [
      ["死链", broken, Math.min(20, broken * 2), "每条扣 2 分，最多 20 分。"],
      ["单向相关", oneWay, Math.min(10, oneWay), "每条扣 1 分，最多 10 分。"],
      ["孤立页", isolated, total ? Math.min(20, Math.round(isolated / total * 20)) : 0,
        "占通用 Wiki 的比例 × 20，四舍五入；地图和来源链接不算连接。"],
    ] as const) {
      if (count) {
        risk.push(`${label} ${count} 项`);
        scoreReasons.push({ label, count, penalty, explanation });
      }
    }
  }
  // Existing knowledge structures remain assessable even when legacy settings
  // have no initialization receipt. Missing core pieces still deduct points.
  const initialized = input.mappedFolders ? Object.values(input.settings.folderBindings?.roles ?? {}).some(binding => binding.enabled) : input.rawExists || input.wikiExists || input.wikiIndexExists || input.trackerExists
    || input.settings.initialization.status === "initialized" || input.settings.initialization.initializedAt > 0;
  const assessment = !initialized || input.structure?.total === 0 ? "uninitialized"
    : input.readFailed ? "unavailable" : input.limited ? "limited" : "local-structure";
  const available = assessment === "local-structure" || assessment === "limited";
  if (!available) scoreReasons.length = 0;
  const score = healthScore(scoreReasons);
  const scoreStatus = healthStatusForScore(score, critical.length > 0);
  const status = available ? scoreStatus : "unknown";
  const label = !available ? initialized ? "无法评估" : "未初始化" : status === "healthy" ? "健康" : status === "risk" ? "风险" : "异常";
  const reasonTexts = [...critical, ...risk];
  const reasons = reasonTexts.length ? reasonTexts : ["已检查的本地结构未发现扣分项"];
  return {
    assessment,
    coverage: "检查已启用的位置、已有来源校准标记及通用 Wiki 的死链、单向相关和孤立页；内容问题不计分。",
    unchecked: ["内容准确性", "过时内容"],
    status,
    label,
    score: available ? score : 0,
    reasons: available ? reasons : [initialized ? "必要文件读取或扫描失败，暂时无法评估" : "初始化完成后显示本地结构评分"],
    scoreSummary: available ? healthScoreSummary(score, status, critical.length > 0) : label,
    scoreReasons,
    scoreCheckNote: HEALTH_SCORE_CHECK_NOTE,
    scoreThresholdText: input.mappedFolders ? "85+ 健康，60–84 风险，低于 60 异常；已启用位置失效各扣 24 分。" : HEALTH_SCORE_THRESHOLD_TEXT,
    lastCheckAt: latestCheckAt,
    streakDays: countHealthStreakDays(history, input.maintenanceHistory),
  };
}

function healthScore(reasons: KnowledgeBaseDashboardHealthScoreReason[]): number {
  const totalPenalty = reasons.reduce((sum, reason) => sum + reason.penalty, 0);
  return Math.max(0, Math.min(100, 100 - totalPenalty));
}

function healthStatusForScore(score: number, hasCritical: boolean): KnowledgeBaseDashboardHealthStatus {
  if (hasCritical || score < 60) return "bad";
  if (score < 85) return "risk";
  return "healthy";
}

function healthScoreSummary(score: number, status: KnowledgeBaseDashboardHealthStatus, hasCritical: boolean): string {
  if (status === "bad" && hasCritical && score >= 60) return `当前 ${score} 分，存在关键问题，显示异常。`;
  if (score < 60) return `当前 ${score} 分，低于 60，显示异常。`;
  if (score < 85) return `当前 ${score} 分，位于 60-84，显示风险。`;
  return `当前 ${score} 分，达到 85+，显示健康。`;
}

function statusByCheckDate(history: KnowledgeBaseHealthHistoryEntry[]): Map<string, "success" | "failed" | "none"> {
  const dates = new Map<string, "success" | "failed" | "none">();
  for (const entry of normalizeHealthHistory(history)) dates.set(entry.date, entry.status);
  return dates;
}
function countHealthStreakDays(history: KnowledgeBaseHealthHistoryEntry[], _maintenanceHistory: KnowledgeBaseMaintenanceHistoryEntry[] = []): number {
  const byDate = statusByCheckDate(history);
  const latest = Array.from(byDate.entries()).sort((left, right) => left[0].localeCompare(right[0])).at(-1);
  if (!latest || latest[1] !== "success") return 0;
  let count = 0;
  let cursor = latest[0];
  while (byDate.get(cursor) === "success") {
    count += 1;
    cursor = shiftDate(cursor, -1);
  }
  return count;
}

function latestHealthEntry(history: KnowledgeBaseHealthHistoryEntry[]): KnowledgeBaseHealthHistoryEntry | null {
  return history.length ? history[history.length - 1] : null;
}

function normalizeHealthHistory(history: KnowledgeBaseHealthHistoryEntry[]): KnowledgeBaseHealthHistoryEntry[] {
  return history
    .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry.date) && (entry.status === "success" || entry.status === "failed"))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function shiftDate(dateKey: string, days: number): string {
  const date = parseDateKey(dateKey);
  date.setDate(date.getDate() + days);
  return formatLocalDateKey(date.getTime());
}

function parseDateKey(value: string): Date {
  const [year, month, day] = value.split("-").map((part) => Number(part));
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function formatLocalDateKey(value: number): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

