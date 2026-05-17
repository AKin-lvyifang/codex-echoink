import {
  DEFAULT_REVIEW_OUTPUT_DIR,
  type ChatMessage,
  type CodexForObsidianSettings,
  type ReviewReportKind,
  type StoredSession
} from "../settings/settings";
import { isKnowledgeBaseSession } from "../settings/settings";
import { parseKnowledgeBaseCommand } from "../knowledge-base/commands";
import { renderReviewHtml, type ReviewHtmlData } from "./review-html-template";
import { reviewRangeKey, type ReviewRange } from "./schedule";

export const REVIEW_OUTPUT_DIR = DEFAULT_REVIEW_OUTPUT_DIR;

export interface ReviewPromptSample {
  scene: string;
  text: string;
}

export interface AgentChatReviewEvidence {
  kind: "agent-chat";
  sessionCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  totalMessageCount: number;
  totalTokens: number;
  contextCompactionCount: number;
  failedMessageCount: number;
  interruptedMessageCount: number;
  toolEventCount: number;
  longSessionCount: number;
  promptSamples: ReviewPromptSample[];
}

export interface KnowledgeBaseDashboardEvidence {
  healthScore?: number;
  rawCount?: number;
  wikiCount?: number;
  outputsCount?: number;
  inboxCount?: number;
  latestReportPath?: string;
}

export interface KnowledgeBaseMaintenanceReportEvidence {
  path: string;
  excerpt: string;
}

export interface KnowledgeBaseReviewEvidence {
  kind: "knowledge-base";
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  failedMessageCount: number;
  commandCounts: {
    init: number;
    maintain: number;
    lint: number;
    ask: number;
    outputs: number;
    inbox: number;
    journal: number;
    collect: number;
    other: number;
  };
  dashboard: KnowledgeBaseDashboardEvidence;
  maintenanceReports: KnowledgeBaseMaintenanceReportEvidence[];
  lastStatus: string;
  lastReportPath: string;
  lastSummary: string;
}

export type ReviewEvidence = AgentChatReviewEvidence | KnowledgeBaseReviewEvidence;

export function collectAgentChatReviewEvidence(settings: CodexForObsidianSettings, range: ReviewRange): AgentChatReviewEvidence {
  const sessions = settings.sessions.filter((session) => !isKnowledgeBaseSession(session, settings.knowledgeBase.sessionId));
  const activeSessions = sessions.filter((session) => messagesInRange(session.messages, range).length > 0);
  const messages = activeSessions.flatMap((session) => messagesInRange(session.messages, range));
  const userMessages = messages.filter((message) => message.role === "user");
  return {
    kind: "agent-chat",
    sessionCount: activeSessions.length,
    userMessageCount: userMessages.length,
    assistantMessageCount: messages.filter((message) => message.role === "assistant").length,
    totalMessageCount: messages.length,
    totalTokens: activeSessions.reduce((sum, session) => sum + readTotalTokens(session), 0),
    contextCompactionCount: messages.filter((message) => message.itemType === "contextCompaction").length,
    failedMessageCount: messages.filter((message) => message.status === "failed" || message.status === "error").length,
    interruptedMessageCount: messages.filter((message) => message.status === "interrupted").length,
    toolEventCount: messages.filter((message) => isToolLikeMessage(message)).length,
    longSessionCount: activeSessions.filter((session) => messagesInRange(session.messages, range).length >= 20 || readTotalTokens(session) >= 500_000).length,
    promptSamples: userMessages.slice(0, 8).map((message) => ({
      scene: formatMessageScene(message),
      text: trimText(message.text, 120)
    }))
  };
}

export function collectKnowledgeBaseReviewEvidence(
  settings: CodexForObsidianSettings,
  range: ReviewRange,
  extras: { dashboard?: KnowledgeBaseDashboardEvidence; maintenanceReports?: KnowledgeBaseMaintenanceReportEvidence[] } = {}
): KnowledgeBaseReviewEvidence {
  const session = settings.sessions.find((item) => isKnowledgeBaseSession(item, settings.knowledgeBase.sessionId));
  const messages = session ? messagesInRange(session.messages, range) : [];
  const userMessages = messages.filter((message) => message.role === "user");
  const commandCounts = {
    init: 0,
    maintain: 0,
    lint: 0,
    ask: 0,
    outputs: 0,
    inbox: 0,
    journal: 0,
    collect: 0,
    other: 0
  };
  for (const message of userMessages) {
    const command = parseKnowledgeBaseCommand(message.text, message.attachments?.length ?? 0);
    if (command.intent === "process-outputs") commandCounts.outputs += 1;
    else if (command.intent === "process-inbox") commandCounts.inbox += 1;
    else if (command.intent === "reingest") commandCounts.maintain += 1;
    else if (command.intent in commandCounts) commandCounts[command.intent as keyof typeof commandCounts] += 1;
    else commandCounts.other += 1;
  }
  return {
    kind: "knowledge-base",
    messageCount: messages.length,
    userMessageCount: userMessages.length,
    assistantMessageCount: messages.filter((message) => message.role === "assistant").length,
    failedMessageCount: messages.filter((message) => message.status === "failed" || message.status === "error").length,
    commandCounts,
    dashboard: extras.dashboard ?? {},
    maintenanceReports: extras.maintenanceReports ?? [],
    lastStatus: settings.knowledgeBase.lastRunStatus,
    lastReportPath: settings.knowledgeBase.lastReportPath,
    lastSummary: settings.knowledgeBase.lastSummary
  };
}

export function reportBaseName(kind: ReviewReportKind, range: ReviewRange): string {
  return `${kind === "knowledge-base" ? "knowledge-base" : "agent-chat"}-review-${reviewRangeKey(range)}`;
}

export function buildReviewDocuments(kind: ReviewReportKind, range: ReviewRange, evidence: ReviewEvidence): { baseName: string; markdown: string; html: string; markdownFileName: string; htmlFileName: string; summary: string } {
  const baseName = reportBaseName(kind, range);
  const htmlFileName = `${baseName}.html`;
  const markdownFileName = `${baseName}.md`;
  const data = kind === "knowledge-base"
    ? buildKnowledgeBaseHtmlData(range, evidence as KnowledgeBaseReviewEvidence)
    : buildAgentChatHtmlData(range, evidence as AgentChatReviewEvidence);
  const html = renderReviewHtml(data);
  const markdown = buildReviewMarkdown(data, htmlFileName);
  return {
    baseName,
    markdown,
    html,
    markdownFileName,
    htmlFileName,
    summary: data.verdict
  };
}

function buildAgentChatHtmlData(range: ReviewRange, evidence: AgentChatReviewEvidence): ReviewHtmlData {
  const promptRows = splitPromptSamples(evidence.promptSamples);
  const hasPromptSamples = evidence.promptSamples.length > 0;
  return {
    title: "Agent 对话使用周复盘",
    periodLabel: `${range.startDate} 至 ${range.endDate}`,
    scopeLabel: "Obsidian / 非知识库频道",
    verdict: evidence.sessionCount
      ? `一眼结论：本周普通 Agent 对话共 ${evidence.sessionCount} 个会话，重点问题是长线程、失败中断和提示词是否前置验收。`
      : "一眼结论：本周没有普通 Agent 对话记录。",
    metrics: [
      { label: "有效会话", value: String(evidence.sessionCount) },
      { label: "用户消息", value: String(evidence.userMessageCount) },
      { label: "本机 tokens", value: formatNumber(evidence.totalTokens) },
      { label: "压缩次数", value: String(evidence.contextCompactionCount) }
    ],
    scores: [
      { label: "方向选择", rating: evidence.sessionCount ? "中上" : "未发生", description: evidence.sessionCount ? "以用户主动发起的普通 Agent 对话为准。" : "没有可评价样本。" },
      { label: "执行效率", rating: evidence.longSessionCount ? "中" : "好", description: evidence.longSessionCount ? "存在长线程或高 token 会话。" : "没有明显长线程信号。" },
      { label: "提示词质量", rating: hasPromptSamples && promptRows.high.some((row) => row.judgement === "高质量") ? "中上" : "待观察", description: hasPromptSamples ? "按本周用户原始提示词样本判断。" : "提示词样本不足。" },
      { label: "决策质量", rating: evidence.failedMessageCount ? "中" : "中上", description: evidence.failedMessageCount ? "存在失败记录，需要看失败前的决策。" : "失败记录少。" },
      { label: "token 使用效率", rating: evidence.totalTokens > 1_000_000 ? "中偏低" : "中上", description: "token 只作为本机使用证据，不等于精确账单。" },
      { label: "使用方式", rating: evidence.sessionCount ? (evidence.toolEventCount ? "好" : "中") : "待观察", description: evidence.sessionCount ? (evidence.toolEventCount ? "包含真实工具执行记录。" : "主要是对话记录。") : "样本不足。" }
    ],
    distribution: [
      { label: "普通 Agent 对话", countLabel: `${evidence.sessionCount} 会话 / ${evidence.totalMessageCount} 消息`, value: evidence.sessionCount ? 100 : 0, description: "只统计非知识库频道。" },
      { label: "工具/过程事件", countLabel: `${evidence.toolEventCount} 条`, value: percentOf(evidence.toolEventCount, evidence.totalMessageCount), description: "命令、文件、MCP 等过程记录。" },
      { label: "失败/中断信号", countLabel: `${evidence.failedMessageCount + evidence.interruptedMessageCount} 条`, value: percentOf(evidence.failedMessageCount + evidence.interruptedMessageCount, evidence.totalMessageCount), description: "用于判断返工和阻塞。" }
    ],
    highQualityPrompts: promptRows.high,
    lowEfficiencyPrompts: promptRows.low,
    goodDecisions: [
      { decision: "把普通对话和知识库频道分开复盘", evaluation: "避免把知识库维护的自动化成本混进普通 Agent 使用效率。" },
      { decision: "保留 token、失败、压缩等本机证据", evaluation: "能客观定位效率问题。" }
    ],
    problemDecisions: [
      { decision: "长线程承载过多阶段", problem: `${evidence.longSessionCount} 个会话触发长线程信号。`, correction: "阶段切换时开新会话，并在首条消息写清目标、边界和验收。" },
      { decision: "失败后继续追加", problem: `${evidence.failedMessageCount} 条失败记录可能导致上下文污染。`, correction: "失败后先要求根因和证据，再决定是否继续。" }
    ],
    reworkItems: [
      { item: "提示词边界不清", surfaceCause: "首轮指令过短", deepCause: "目标、约束、验收没有前置", correction: "首轮固定写目标、现状、范围、验收。" },
      { item: "上下文压缩", surfaceCause: `${evidence.contextCompactionCount} 次压缩`, deepCause: "线程过长或过程记录过多", correction: "长任务拆阶段，并沉淀 brief。" }
    ],
    goodHabits: [
      { habit: "要求证据链", evaluation: "能减少猜测，适合工程和本机排查。" },
      { habit: "让 Agent 先判断再执行", evaluation: "能降低返工。" }
    ],
    badHabits: [
      { habit: "一句话启动大任务", problem: "容易让 Agent 先做后校准。", correction: "先让 Agent 拆目标和风险。" },
      { habit: "长线程继续追加", problem: "上下文越来越重。", correction: "按阶段重开会话。" }
    ],
    templates: defaultPromptTemplates(),
    checklist: defaultChecklist(evidence.failedMessageCount, evidence.longSessionCount),
    finalJudgement: evidence.sessionCount
      ? "本周普通 Agent 对话已经有可复盘证据。重点不是增加使用次数，而是压低长线程、失败后追加和验收后置。"
      : "本周普通 Agent 对话样本不足，暂不评价效率。"
  };
}

function buildKnowledgeBaseHtmlData(range: ReviewRange, evidence: KnowledgeBaseReviewEvidence): ReviewHtmlData {
  const commandTotal = Object.values(evidence.commandCounts).reduce((sum, value) => sum + value, 0);
  const reportPaths = uniqueCompact([
    ...evidence.maintenanceReports.map((report) => report.path),
    evidence.lastReportPath,
    evidence.dashboard.latestReportPath
  ]);
  return {
    title: "知识库使用周复盘",
    periodLabel: `${range.startDate} 至 ${range.endDate}`,
    scopeLabel: "Obsidian / 知识库频道",
    verdict: commandTotal
      ? `一眼结论：本周知识库频道发生 ${commandTotal} 次用户请求，重点看维护、体检、问答和健康状态是否稳定。`
      : "一眼结论：本周知识库频道没有明显使用记录。",
    metrics: [
      { label: "频道消息", value: String(evidence.messageCount) },
      { label: "用户请求", value: String(evidence.userMessageCount) },
      { label: "健康分", value: evidence.dashboard.healthScore === undefined ? "未知" : String(evidence.dashboard.healthScore) },
      { label: "失败数", value: String(evidence.failedMessageCount) }
    ],
    scores: [
      { label: "方向选择", rating: commandTotal ? "好" : "未发生", description: "只评价知识库频道，不混入普通 Agent 对话。" },
      { label: "执行效率", rating: evidence.failedMessageCount ? "中" : "中上", description: evidence.failedMessageCount ? "存在失败记录。" : "失败信号少。" },
      { label: "提示词质量", rating: evidence.commandCounts.ask || evidence.commandCounts.lint ? "中上" : "待观察", description: "命令越明确，越容易稳定复盘。" },
      { label: "决策质量", rating: "中上", description: "知识库任务围绕 raw/wiki/outputs/inbox 展开。" },
      { label: "token 使用效率", rating: "中", description: "插件内只保留周报行为证据，不做精确账单判断。" },
      { label: "使用方式", rating: commandTotal ? "好" : "待观察", description: commandTotal ? "已形成知识库频道使用记录。" : "样本不足。" }
    ],
    distribution: [
      { label: "体检", countLabel: `${evidence.commandCounts.lint} 次`, value: percentOf(evidence.commandCounts.lint, Math.max(1, commandTotal)), description: "检查断链、孤儿页和维护风险。" },
      { label: "维护/重提炼", countLabel: `${evidence.commandCounts.maintain} 次`, value: percentOf(evidence.commandCounts.maintain, Math.max(1, commandTotal)), description: "消化 raw 或重新提炼资料。" },
      { label: "问答", countLabel: `${evidence.commandCounts.ask} 次`, value: percentOf(evidence.commandCounts.ask, Math.max(1, commandTotal)), description: "只读查询 wiki 依据。" },
      { label: "收集/日记/整理", countLabel: `${evidence.commandCounts.collect + evidence.commandCounts.journal + evidence.commandCounts.outputs + evidence.commandCounts.inbox} 次`, value: percentOf(evidence.commandCounts.collect + evidence.commandCounts.journal + evidence.commandCounts.outputs + evidence.commandCounts.inbox, Math.max(1, commandTotal)), description: "进入 raw、journal、outputs 或 inbox 的动作。" }
    ],
    highQualityPrompts: [
      { scene: "知识库频道", excerpt: "使用 /check、/ask、/maintain 等明确命令", judgement: "高质量", reason: "命令意图清楚，可复盘。" },
      { scene: "体检任务", excerpt: "只体检、只看断链、只读问答", judgement: "高质量", reason: "能限制写入范围。" }
    ],
    lowEfficiencyPrompts: [
      { scene: "知识库频道", excerpt: "整理一下", problem: "范围过泛", impact: "Agent 可能不知道处理 raw、wiki、outputs 还是 inbox。", correction: "改成 /check、/maintain、/outputs、/inbox 或 /ask。" },
      { scene: "知识库频道", excerpt: "全部重做", problem: "风险高", impact: "容易触发大范围重写。", correction: "限定具体目录、文件和验收标准。" }
    ],
    goodDecisions: [
      { decision: "把知识库频道单独复盘", evaluation: "能看清 raw/wiki/outputs/inbox 的真实使用情况。" },
      { decision: "保留最近维护报告", evaluation: "报告文件可以作为下次体检的证据。" }
    ],
    problemDecisions: [
      { decision: "未指定知识库动作", problem: "命令不清会扩大任务范围。", correction: "首词使用 /check、/maintain、/outputs、/inbox、/ask。" },
      { decision: "失败后不复查报告", problem: `${evidence.failedMessageCount} 条失败信号可能被忽略。`, correction: "先打开最近报告，再决定是否重跑。" }
    ],
    reworkItems: [
      { item: "raw/wiki 状态漂移", surfaceCause: "索引和 tracker 可能不同步", deepCause: "新增资料未及时维护", correction: "周报里持续看健康分和最近报告。" },
      { item: "问答依据不清", surfaceCause: "自然语言问题没有限定来源", deepCause: "wiki 命中和补充信息混在一起", correction: "优先用 /ask 并要求区分 Vault 依据。" }
    ],
    goodHabits: [
      { habit: "使用知识库频道", evaluation: "比普通聊天更适合当前 Vault 维护。" },
      { habit: "生成维护报告", evaluation: "让知识库健康状态可追溯。" }
    ],
    badHabits: [
      { habit: "命令太泛", problem: "容易让维护任务越界。", correction: "选择明确命令并追加限制。" },
      { habit: "不看最近报告", problem: "容易重复体检或忽略风险。", correction: "先打开最近报告，再决定下一步。" }
    ],
    templates: defaultPromptTemplates(),
    checklist: [
      { item: "raw/wiki/outputs/inbox 健康信号", judgement: formatKnowledgeBaseDirectorySignal(evidence.dashboard) },
      { item: "wiki 是否健康", judgement: evidence.dashboard.healthScore === undefined ? "健康分未知。" : `健康分：${evidence.dashboard.healthScore}。` },
      { item: "近期维护报告", judgement: reportPaths.length ? reportPaths.join("；") : "未记录最近报告。" },
      { item: "是否混入普通对话", judgement: "否，本报告只统计知识库频道。" }
    ],
    finalJudgement: commandTotal
      ? "本周知识库使用已经有可观察记录。重点是继续用明确命令约束范围，并让维护报告成为判断知识库健康的证据。"
      : "本周知识库使用样本不足，暂不评价效率。"
  };
}

export function buildReviewMarkdown(data: ReviewHtmlData, htmlFileName: string): string {
  return [
    "---",
    `created: ${formatLocalDateTime(new Date())}`,
    `updated: ${formatLocalDateTime(new Date())}`,
    "---",
    `# ${data.title}`,
    "",
    `[打开同名 HTML 看板](./${htmlFileName})`,
    "",
    `周期：${data.periodLabel}  `,
    `口径：${data.scopeLabel}`,
    "",
    "## 1. 一眼结论",
    "",
    data.verdict,
    "",
    "| 维度 | 评价 | 说明 |",
    "|---|---|---|",
    ...data.scores.map((item) => `| ${mdCell(item.label)} | ${mdCell(item.rating)} | ${mdCell(item.description)} |`),
    "",
    "## 2. 使用分布审查",
    "",
    "| 类别 | 使用情况 | 评价 |",
    "|---|---|---|",
    ...data.distribution.map((item) => `| ${mdCell(item.label)} | ${mdCell(item.countLabel)} | ${mdCell(item.description)} |`),
    "",
    "## 3. 提示词质量审查",
    "",
    "### 3.1 高质量提示词",
    "",
    "| 日期 / 场景 | 原始提示词摘录 | 判断 | 为什么好 |",
    "|---|---|---|---|",
    ...data.highQualityPrompts.map((item) => `| ${mdCell(item.scene)} | ${mdCell(item.excerpt)} | ${mdCell(item.judgement)} | ${mdCell(item.reason)} |`),
    "",
    "### 3.2 低效提示词",
    "",
    "| 日期 / 场景 | 原始提示词摘录 | 问题 | 影响 | 修正方式 |",
    "|---|---|---|---|---|",
    ...data.lowEfficiencyPrompts.map((item) => `| ${mdCell(item.scene)} | ${mdCell(item.excerpt)} | ${mdCell(item.problem)} | ${mdCell(item.impact)} | ${mdCell(item.correction)} |`),
    "",
    "## 4. 决策质量审查",
    "",
    "### 4.1 好决策",
    "",
    "| 决策 | 评价 |",
    "|---|---|",
    ...data.goodDecisions.map((item) => `| ${mdCell(item.decision)} | ${mdCell(item.evaluation)} |`),
    "",
    "### 4.2 问题决策",
    "",
    "| 决策/行为 | 问题 | 修正方式 |",
    "|---|---|---|",
    ...data.problemDecisions.map((item) => `| ${mdCell(item.decision)} | ${mdCell(item.problem)} | ${mdCell(item.correction)} |`),
    "",
    "## 5. 重复返工审查",
    "",
    "| 返工点 | 表面原因 | 深层原因 | 修正方式 |",
    "|---|---|---|---|",
    ...data.reworkItems.map((item) => `| ${mdCell(item.item)} | ${mdCell(item.surfaceCause)} | ${mdCell(item.deepCause)} | ${mdCell(item.correction)} |`),
    "",
    "## 6. 使用习惯审查",
    "",
    "### 6.1 好习惯",
    "",
    "| 习惯 | 评价 |",
    "|---|---|",
    ...data.goodHabits.map((item) => `| ${mdCell(item.habit)} | ${mdCell(item.evaluation)} |`),
    "",
    "### 6.2 坏习惯",
    "",
    "| 习惯 | 问题 | 修正方式 |",
    "|---|---|---|",
    ...data.badHabits.map((item) => `| ${mdCell(item.habit)} | ${mdCell(item.problem)} | ${mdCell(item.correction)} |`),
    "",
    "## 7. 提示词修正模板",
    "",
    ...data.templates.flatMap((item) => [`### ${item.title}`, "", "```text", item.body, "```", ""]),
    "## 8. 固定审查项",
    "",
    "| 审查项 | 判断 |",
    "|---|---|",
    ...data.checklist.map((item) => `| ${mdCell(item.item)} | ${mdCell(item.judgement)} |`),
    "",
    "## 9. 最终判断",
    "",
    data.finalJudgement,
    ""
  ].join("\n");
}

function splitPromptSamples(samples: ReviewPromptSample[]): { high: ReviewHtmlData["highQualityPrompts"]; low: ReviewHtmlData["lowEfficiencyPrompts"] } {
  const high = samples
    .filter((sample) => /先|判断|验收|证据|复现|根因|不要|范围|目标|确认/.test(sample.text))
    .slice(0, 5)
    .map((sample) => ({ scene: sample.scene, excerpt: sample.text, judgement: "高质量", reason: "目标、限制或验收前置。" }));
  const low = samples
    .filter((sample) => !/先|判断|验收|证据|复现|根因|不要|范围|目标|确认/.test(sample.text))
    .slice(0, 5)
    .map((sample) => ({ scene: sample.scene, excerpt: sample.text, problem: "指令偏泛", impact: "容易让 Agent 自行补目标。", correction: "补充目标、上下文、范围和验收标准。" }));
  if (!high.length) high.push({ scene: "样本不足", excerpt: "本周未发现明显高质量提示词样本。", judgement: "待观察", reason: "需要更多用户原始提示词。" });
  if (!low.length) low.push({ scene: "样本不足", excerpt: "本周未发现明显低效提示词样本。", problem: "待观察", impact: "暂无", correction: "继续保持前置验收和证据要求。" });
  return { high, low };
}

function defaultPromptTemplates(): ReviewHtmlData["templates"] {
  return [
    { title: "产品判断类", body: "先不要实现。\n\n请先判断这个需求是否成立：\n1. 真实目标是什么？\n2. 可能有哪些错误假设？\n3. 哪些部分值得做，哪些不值得做？\n4. 如果要做，验收标准是什么？\n5. 哪些问题必须先确认？" },
    { title: "Bug 排查类", body: "请按 bug 排查方式处理：\n\n1. 先复现或确认现象。\n2. 找到相关代码链路。\n3. 说明根因，不要只猜。\n4. 给修复方案。\n5. 修复后跑验证。\n6. 最后告诉我证据。" },
    { title: "大功能类", body: "这个任务可能会很大。\n\n先拆成：\n1. 产品目标\n2. 用户路径\n3. 技术边界\n4. 风险点\n5. 验收标准\n\n拆完后先给我看，不要直接写代码。" },
    { title: "防止返工类", body: "在执行前，请先指出：\n1. 这个需求里最可能导致返工的地方。\n2. 哪些判断如果错了，后面会重做。\n3. 你建议先验证哪 3 件事。" }
  ];
}

function defaultChecklist(failedCount: number, longSessionCount: number): ReviewHtmlData["checklist"] {
  return [
    { item: "时间是否集中在高价值主线", judgement: "看有效会话和消息分布。" },
    { item: "提示词是否前置验收", judgement: "看高质量提示词样本。" },
    { item: "是否过早实现", judgement: failedCount ? "存在失败信号，需要复查。" : "暂无明显失败信号。" },
    { item: "是否重复读上下文", judgement: longSessionCount ? `${longSessionCount} 个长线程信号。` : "暂无明显长线程信号。" },
    { item: "是否发生返工", judgement: "用失败、中断、压缩和重复要求判断。" },
    { item: "输出是否有证据", judgement: "看工具事件和报告文件。" }
  ];
}

function messagesInRange(messages: ChatMessage[], range: ReviewRange): ChatMessage[] {
  return messages.filter((message) => message.createdAt >= range.startAt && message.createdAt <= range.endAt);
}

function isToolLikeMessage(message: ChatMessage): boolean {
  return message.role === "tool" || ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(message.itemType ?? "");
}

function readTotalTokens(session: StoredSession): number {
  const total = session.tokenUsage?.total?.totalTokens;
  return typeof total === "number" && Number.isFinite(total) ? Math.max(0, Math.round(total)) : 0;
}

function formatMessageScene(message: ChatMessage): string {
  const date = new Date(message.createdAt);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} / 用户提示`;
}

function trimText(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function percentOf(value: number, total: number): number {
  if (!total) return 0;
  return Math.max(0, Math.min(100, value / total * 100));
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(value)));
}

function formatKnowledgeBaseDirectorySignal(evidence: KnowledgeBaseDashboardEvidence): string {
  const parts = [
    formatOptionalCount("raw", evidence.rawCount),
    formatOptionalCount("wiki", evidence.wikiCount),
    formatOptionalCount("outputs", evidence.outputsCount),
    formatOptionalCount("inbox", evidence.inboxCount)
  ].filter(Boolean);
  return parts.length ? parts.join("；") : "未读取到目录快照。";
}

function formatOptionalCount(label: string, value: number | undefined): string {
  return value === undefined ? "" : `${label} ${value}`;
}

function uniqueCompact(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));
}

function mdCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, "<br>");
}

function formatLocalDateTime(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}
