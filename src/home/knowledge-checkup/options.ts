import type { KnowledgeCheckupIssue } from "../../knowledge-base/knowledge-checkup";
import type { CheckupAction } from "../../plugin/knowledge-checkup-service";
export function recommendedCheckupAction(
  issue: KnowledgeCheckupIssue,
): { value: CheckupAction; label: string } {
  const primary: Record<KnowledgeCheckupIssue["kind"], { value: CheckupAction; label: string }> = {
    broken: {
      value: "repair",
      label: issue.candidates?.length === 1 ? "修复链接" : "选择目标后修复",
    },
    isolated: { value: "relate", label: "挂上相关条目" },
    oneWay: { value: "reverse", label: "补反向" },
    thin: issue.sources?.length
      ? { value: "maintain", label: "重新提炼" }
      : { value: "later", label: "来源缺失，先保留" },
    source: { value: "later", label: "保留待处理" },
    unplaced: {
      value: "place",
      label: issue.suggestedBranch ? `放入 ${issue.suggestedBranch}` : "判断并归位",
    },
    missingType: { value: "upgrade", label: "去升级" },
    pendingType: { value: "upgrade", label: "去升级核对" },
    outdated: { value: "verify", label: "标记待核实" },
  };
  return primary[issue.kind];
}
