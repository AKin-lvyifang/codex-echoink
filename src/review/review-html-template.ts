export interface ReviewMetricCard {
  label: string;
  value: string;
}

export interface ReviewScoreCard {
  label: string;
  rating: string;
  description: string;
}

export interface ReviewDistributionRow {
  label: string;
  countLabel: string;
  value: number;
  description: string;
}

export interface ReviewPromptGoodRow {
  scene: string;
  excerpt: string;
  judgement: string;
  reason: string;
}

export interface ReviewPromptBadRow {
  scene: string;
  excerpt: string;
  problem: string;
  impact: string;
  correction: string;
}

export interface ReviewDecisionRow {
  decision: string;
  evaluation: string;
}

export interface ReviewProblemDecisionRow {
  decision: string;
  problem: string;
  correction: string;
}

export interface ReviewReworkRow {
  item: string;
  surfaceCause: string;
  deepCause: string;
  correction: string;
}

export interface ReviewHabitRow {
  habit: string;
  evaluation: string;
}

export interface ReviewBadHabitRow {
  habit: string;
  problem: string;
  correction: string;
}

export interface ReviewTemplateBlock {
  title: string;
  body: string;
}

export interface ReviewChecklistRow {
  item: string;
  judgement: string;
}

export interface ReviewHtmlData {
  title: string;
  periodLabel: string;
  scopeLabel: string;
  verdict: string;
  metrics: ReviewMetricCard[];
  scores: ReviewScoreCard[];
  distribution: ReviewDistributionRow[];
  highQualityPrompts: ReviewPromptGoodRow[];
  lowEfficiencyPrompts: ReviewPromptBadRow[];
  goodDecisions: ReviewDecisionRow[];
  problemDecisions: ReviewProblemDecisionRow[];
  reworkItems: ReviewReworkRow[];
  goodHabits: ReviewHabitRow[];
  badHabits: ReviewBadHabitRow[];
  templates: ReviewTemplateBlock[];
  checklist: ReviewChecklistRow[];
  finalJudgement: string;
}

export const REVIEW_SECTION_HEADINGS = [
  "1. 总体评分",
  "2. 使用分布",
  "3. 提示词质量",
  "4. 决策质量",
  "5. 返工地图",
  "6. 使用习惯审查",
  "7. 提示词修正模板",
  "8. 固定审查项",
  "9. 最终判断"
];

export const REVIEW_HTML_CSS = `:root{--bg:#fffdf8;--card:#ffffff;--line:#dce8e2;--mint:#d8f1e7;--mint2:#edf8f3;--blue:#e7f0f7;--green:#4f8b72;--text:#24312d;--muted:#687772;--amber:#fff2cf;--shadow:0 8px 24px rgba(40,72,62,.08);}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;line-height:1.55}.wrap{max-width:1180px;margin:0 auto;padding:28px 18px 56px}.hero{border:1px solid var(--line);background:linear-gradient(180deg,var(--mint2),#fff);border-radius:8px;padding:28px;box-shadow:var(--shadow)}h1{margin:0 0 8px;font-size:30px;letter-spacing:0}h2{margin:34px 0 14px;font-size:20px}h3{margin:20px 0 10px;font-size:16px}p{margin:8px 0;color:var(--muted)}.verdict{font-size:17px;color:var(--text);max-width:900px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:18px}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;box-shadow:var(--shadow)}.metric b{display:block;font-size:22px;margin-top:4px}.score{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.pill{display:inline-block;border:1px solid var(--line);background:var(--mint);border-radius:999px;padding:2px 8px;font-size:12px;color:#315f4e}.table{display:block;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#fff}.tr{display:grid;grid-template-columns:1.1fr 1fr 1.6fr;gap:0;border-top:1px solid var(--line)}.tr:first-child{border-top:0}.tr>div{padding:12px;border-left:1px solid var(--line);min-width:0;overflow-wrap:anywhere}.tr>div:first-child{border-left:0}.head{background:var(--blue);font-weight:700}.wide .tr{grid-template-columns:1fr 1.4fr 1fr 1.5fr}.low .tr{grid-template-columns:.9fr 1.4fr .8fr 1fr 1.2fr}.decision .tr{grid-template-columns:1fr 1.4fr}.baddecision .tr{grid-template-columns:1fr 1fr 1.2fr}.barrow{background:#fff;border:1px solid var(--line);border-radius:8px;padding:14px;margin:10px 0;box-shadow:var(--shadow)}.barlabel{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.bar{height:10px;background:#eef4f1;border-radius:999px;overflow:hidden;margin:10px 0}.bar i{display:block;height:100%;background:linear-gradient(90deg,#9bd8c1,#9fc9df)}.templates{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f7fbf8;border:1px solid var(--line);border-radius:8px;padding:12px;font-size:13px}.note{background:var(--amber)}@media(max-width:760px){.grid,.score,.templates{grid-template-columns:1fr}.tr,.wide .tr,.low .tr,.decision .tr,.baddecision .tr{grid-template-columns:1fr}.tr>div{border-left:0;border-top:1px solid var(--line)}.tr>div:first-child{border-top:0}h1{font-size:24px}}`;

export function renderReviewHtml(data: ReviewHtmlData): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(data.title)} ${escapeHtml(data.periodLabel)}</title><style>
${REVIEW_HTML_CSS}
</style></head><body><main class="wrap"><section class="hero"><span class="pill">${escapeHtml(data.scopeLabel)}</span><h1>${escapeHtml(data.title)}</h1><p>周期：${escapeHtml(data.periodLabel)}</p><p class="verdict">${escapeHtml(data.verdict)}</p><div class="grid">${data.metrics.map(renderMetric).join("")}</div></section><h2>${REVIEW_SECTION_HEADINGS[0]}</h2><section class="score">${data.scores.map(renderScore).join("")}</section><h2>${REVIEW_SECTION_HEADINGS[1]}</h2>${data.distribution.map(renderDistribution).join("")}<h2>${REVIEW_SECTION_HEADINGS[2]}</h2><h3>高质量提示词</h3><div class="wide"><div class="table"><div class="tr head"><div>日期 / 场景</div><div>原始摘录</div><div>判断</div><div>原因</div></div>${data.highQualityPrompts.map(renderGoodPrompt).join("")}</div></div><h3>低效提示词</h3><div class="low"><div class="table"><div class="tr head"><div>日期 / 场景</div><div>原始摘录</div><div>问题</div><div>影响</div><div>修正方式</div></div>${data.lowEfficiencyPrompts.map(renderBadPrompt).join("")}</div></div><h2>${REVIEW_SECTION_HEADINGS[3]}</h2><h3>好决策</h3><div class="decision"><div class="table"><div class="tr head"><div>决策</div><div>评价</div></div>${data.goodDecisions.map(renderDecision).join("")}</div></div><h3>问题决策</h3><div class="baddecision"><div class="table"><div class="tr head"><div>决策/行为</div><div>问题</div><div>修正方式</div></div>${data.problemDecisions.map(renderProblemDecision).join("")}</div></div><h2>${REVIEW_SECTION_HEADINGS[4]}</h2><div class="wide"><div class="table"><div class="tr head"><div>返工点</div><div>表面原因</div><div>深层原因</div><div>修正方式</div></div>${data.reworkItems.map(renderRework).join("")}</div></div><h2>${REVIEW_SECTION_HEADINGS[5]}</h2><h3>好习惯</h3><div class="decision"><div class="table"><div class="tr head"><div>习惯</div><div>评价</div></div>${data.goodHabits.map(renderHabit).join("")}</div></div><h3>坏习惯</h3><div class="baddecision"><div class="table"><div class="tr head"><div>习惯</div><div>问题</div><div>修正方式</div></div>${data.badHabits.map(renderBadHabit).join("")}</div></div><h2>${REVIEW_SECTION_HEADINGS[6]}</h2><section class="templates">${data.templates.map(renderTemplateBlock).join("")}</section><h2>${REVIEW_SECTION_HEADINGS[7]}</h2><div class="decision"><div class="table"><div class="tr head"><div>审查项</div><div>判断</div></div>${data.checklist.map(renderChecklist).join("")}</div></div><h2>${REVIEW_SECTION_HEADINGS[8]}</h2><section class="card note"><p>${escapeHtml(data.finalJudgement)}</p></section></main></body></html>`;
}

function renderMetric(item: ReviewMetricCard): string {
  return `<div class="card metric"><span>${escapeHtml(item.label)}</span><b>${escapeHtml(item.value)}</b></div>`;
}

function renderScore(item: ReviewScoreCard): string {
  return `<div class="card"><span class="pill">${escapeHtml(item.label)}</span><h3>${escapeHtml(item.rating)}</h3><p>${escapeHtml(item.description)}</p></div>`;
}

function renderDistribution(item: ReviewDistributionRow): string {
  const width = Math.max(0, Math.min(100, item.value));
  return `<div class="barrow"><div class="barlabel"><b>${escapeHtml(item.label)}</b><span>${escapeHtml(item.countLabel)}</span></div><div class="bar"><i style="width:${width.toFixed(1)}%"></i></div><p>${escapeHtml(item.description)}</p></div>`;
}

function renderGoodPrompt(item: ReviewPromptGoodRow): string {
  return `<div class="tr"><div>${escapeHtml(item.scene)}</div><div>${escapeHtml(item.excerpt)}</div><div>${escapeHtml(item.judgement)}</div><div>${escapeHtml(item.reason)}</div></div>`;
}

function renderBadPrompt(item: ReviewPromptBadRow): string {
  return `<div class="tr"><div>${escapeHtml(item.scene)}</div><div>${escapeHtml(item.excerpt)}</div><div>${escapeHtml(item.problem)}</div><div>${escapeHtml(item.impact)}</div><div>${escapeHtml(item.correction)}</div></div>`;
}

function renderDecision(item: ReviewDecisionRow): string {
  return `<div class="tr"><div>${escapeHtml(item.decision)}</div><div>${escapeHtml(item.evaluation)}</div></div>`;
}

function renderProblemDecision(item: ReviewProblemDecisionRow): string {
  return `<div class="tr"><div>${escapeHtml(item.decision)}</div><div>${escapeHtml(item.problem)}</div><div>${escapeHtml(item.correction)}</div></div>`;
}

function renderRework(item: ReviewReworkRow): string {
  return `<div class="tr"><div>${escapeHtml(item.item)}</div><div>${escapeHtml(item.surfaceCause)}</div><div>${escapeHtml(item.deepCause)}</div><div>${escapeHtml(item.correction)}</div></div>`;
}

function renderHabit(item: ReviewHabitRow): string {
  return `<div class="tr"><div>${escapeHtml(item.habit)}</div><div>${escapeHtml(item.evaluation)}</div></div>`;
}

function renderBadHabit(item: ReviewBadHabitRow): string {
  return `<div class="tr"><div>${escapeHtml(item.habit)}</div><div>${escapeHtml(item.problem)}</div><div>${escapeHtml(item.correction)}</div></div>`;
}

function renderTemplateBlock(item: ReviewTemplateBlock): string {
  return `<div class="card"><h3>${escapeHtml(item.title)}</h3><pre>${escapeHtml(item.body)}</pre></div>`;
}

function renderChecklist(item: ReviewChecklistRow): string {
  return `<div class="tr"><div>${escapeHtml(item.item)}</div><div>${escapeHtml(item.judgement)}</div></div>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
