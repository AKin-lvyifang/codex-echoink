import type { BuiltinSkillId } from "./builtin-skills";

export function normalizeTaskText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

/** A free product rule, independent of access to the paid audit procedure. */
export function requiresProductFreshnessVerification(text: string): boolean {
  return builtinTrigger("evidence-freshness-audit", normalizeTaskText(text)).requiresFreshnessVerification;
}

export function isSimpleTask(text: string): boolean {
  if (!text) return true;
  if (/^(你好|嗨|谢谢|收到|好的|ok|hello|hi|thanks)[!！,.，。?？\s]*$/iu.test(text)) {
    return true;
  }
  return text.length <= 24 && /^(翻译|改写|润色|计算|告诉我|what is|define)\b/iu.test(text);
}

export function builtinTrigger(
  id: BuiltinSkillId,
  text: string
): Readonly<{
  matched: boolean;
  score: number;
  requiresFreshnessVerification: boolean;
}> {
  const hit = (pattern: RegExp) => pattern.test(text);
  const financeOperation = !hit(/导入|csv|xlsx|生成.{0,8}报告|财务分析|分析报告|月度报告/iu)
    && hit(/记账|记(?:一下|一笔|下来).{0,60}(?:钱|元|块|早餐|午餐|晚餐|高铁)|(?:预算|账单).{0,30}(?:调整|修改|改|设|查询|多少)|(?:改|调整|建|创建|查).{0,30}(?:预算|账单)|(?:刚才|这|那).{0,8}笔|(?:支出|消费|花了).{0,15}(?:多少|查询)|(?:finance|budget|bill).{0,30}(?:record|query|update|create|change)|(?:record|log).{0,30}(?:expense|breakfast|lunch|dinner)/iu);
  if (id === "finance-operations") return trigger(financeOperation, 96);
  if (id === "finance-analysis" || id === "finance-bill-import") return trigger(false, 0);
  if (financeOperation && id === "evidence-freshness-audit") return trigger(false, 0);
  if (id === "daily-journal" || id === "english-diary") {
    return trigger(false, 0);
  }
  if (id === "obsidian-cli") return trigger(hit(/obsidian.?cli|原生.*命令|命令行.*obsidian/iu), 84);
  if (id === "obsidian-markdown") return trigger(hit(/obsidian.*markdown|双链|wikilink|callout|frontmatter|笔记.*(?:嵌入|属性)|属性.*笔记/iu), 72);
  if (id === "obsidian-bases") return trigger(hit(/\.base\b|obsidian.?bases|笔记.*(?:表格视图|筛选|公式|汇总)/iu), 84);
  if (id === "json-canvas") return trigger(hit(/\.canvas\b|json.?canvas|obsidian.*(?:canvas|白板)|白板.*(?:节点|连线)/iu), 84);
  if (id === "clarify-real-question") {
    return trigger(hit(/说不清|有点乱|互相矛盾|目标.*(?:但是|却)|到底要解决|不知道.*问题|信息矛盾/iu), 62);
  }
  if (id === "two-layer-explanation") {
    return trigger(hit(/小白|零基础|没听懂|听不懂|通俗|大白话|简单解释|eli5|layman/iu), 70);
  }
  if (id === "deep-understanding") {
    return trigger(hit(/深入|深度|拆解|反向分析|横向比较|纵向梳理|竞品|演化|系统认识|研究(?:这个|一下)|analy[sz]e|deep dive/iu), 58);
  }
  if (id === "evidence-freshness-audit") {
    const explicit = hit(/核实|核验|查证|真假|可靠吗|是否真实|证据|来源|事实检查|fact.?check/iu);
    const fast = hit(/最新|现在|当前|截至|今天|价格|政策|法规|版本|模型能力|ai\s|人工智能|产品能力|实时|recent|current|latest|today|price|policy/iu);
    return trigger(explicit || fast, explicit ? 100 : 92, fast);
  }
  if (id === "multi-lens-problem-solving") {
    return trigger(hit(/多视角|跨学科|第一性原理|跨领域|不断打补丁|常规方法.*失效|复杂矛盾|重新从零/iu), 64);
  }
  if (id === "minimum-real-world-experiment") {
    return trigger(hit(/验证假设|最小实验|现实实验|低成本验证|可逆.*试|mvp|a\/b|试点|小范围试/iu), 65);
  }
  if (id === "knowledge-review") {
    return trigger(hit(/知识复盘|复盘.*知识|回看.*知识|重新思考.*主题|review.*knowledge/iu), 68);
  }
  const intent = hit(/探索.*(?:天赋|优势|人生|职业|方向)|人生设计|职业方向|长期行为模式|未来路径|我的优势|我的天赋/iu);
  const evidence = hit(/经历|过去|做过|具体例子|真实反馈|他人反馈|愿意.*分享/iu);
  return trigger(intent && (evidence || hit(/帮我探索|帮我设计/iu)), 66);
}

function trigger(
  matched: boolean,
  score: number,
  requiresFreshnessVerification = false
): Readonly<{ matched: boolean; score: number; requiresFreshnessVerification: boolean }> {
  return Object.freeze({ matched, score, requiresFreshnessVerification });
}
