import type {
  KnowledgeCheckupIssue,
  KnowledgeCheckupSnapshot,
} from "../../knowledge-base/knowledge-checkup";
import { checkupTitle } from "../../knowledge-base/knowledge-checkup";
import type {
  DeepCheckupFinding,
  DeepCheckupSnapshot,
} from "../../knowledge-base/knowledge-deep-checkup";
import type { CheckupSelection, CheckupAction } from "../../plugin/knowledge-checkup-service";
import { recommendedCheckupAction } from "./options";

export interface CheckupRow {
  id: string;
  kind: string;
  title: string;
  path: string;
  action: string;
  recommended: CheckupSelection["action"];
  issue?: KnowledgeCheckupIssue;
  finding?: DeepCheckupFinding;
}
export const CHECKUP_GROUPS = [
  {
    label: "链接",
    kinds: [
      ["broken", "死链"],
      ["oneWay", "单向相关"],
      ["isolated", "孤立页"],
    ],
  },
  {
    label: "内容",
    kinds: [
      ["thin", "内容太薄"],
      ["missingType", "缺类型"],
      ["pendingType", "类型待确认"],
    ],
  },
  {
    label: "来源和归位",
    kinds: [
      ["source", "来源有问题"],
      ["unplaced", "待归位"],
    ],
  },
  {
    label: "深查发现",
    kinds: [
      ["duplicate", "疑似重复"],
      ["contradiction", "内容矛盾"],
      ["outdated", "可能过时"],
      ["nearDomain", "近义领域"],
    ],
  },
] as const;

/** Presentation data is separate from diagnosis and repair planning. */
export function checkupRows(
  quick: KnowledgeCheckupSnapshot,
  deep?: DeepCheckupSnapshot,
): CheckupRow[] {
  const rows: CheckupRow[] = quick.issues.map((issue) => {
    const primary = recommendedCheckupAction(issue);
    let action = primary.label;
    let recommended = primary.value;
    if (issue.kind === "broken") {
      const count = issue.candidates?.length ?? 0;
      recommended = count === 1 ? "repair" : "later";
      action = `${issue.target} → ${count === 1 ? checkupTitle(issue.candidates![0]) : count ? "选择目标" : "没有同名页"}`;
    }
    if (issue.kind === "isolated") {
      action = quick.candidates.length > 1 ? "挂上推荐的相关条目" : "没有可关联条目";
      if (quick.candidates.length < 2) recommended = "later";
    }
    return {
      id: issue.id,
      kind: issue.kind,
      title: issue.title,
      path: issue.path,
      action,
      recommended,
      issue,
    };
  });
  for (const finding of deep?.findings ?? [])
    rows.push({
      id: finding.id,
      kind: finding.kind,
      title: (finding.domains ?? finding.paths.map(checkupTitle)).join(" ↔ "),
      path: finding.paths[0],
      recommended: finding.kind === "outdated" ? "verify" : deepRepairOptions(finding)[0].value,
      action:
        finding.kind === "outdated"
          ? "标记待核实"
          : finding.kind === "duplicate"
            ? finding.confidence === "high"
              ? "拿得准"
              : "拿不准"
            : "查看原句",
      finding,
    });
  return rows;
}
export function rowRepair(
  row: CheckupRow,
  selection: CheckupSelection,
): CheckupSelection["action"] {
  if (row.finding && row.kind !== "outdated") {
    if (selection.action !== "later") return selection.action;
    if (selection.choice && selection.choice !== "later") return selection.choice;
    return deepRepairOptions(row.finding).find(option => option.value !== "later")!.value;
  }
  return row.issue?.kind === "broken" && selection.target ? "repair" : row.recommended;
}

export function deepRepairOptions(finding: DeepCheckupFinding): { value: CheckupAction; label: string }[] {
  if (finding.kind === "duplicate") return [
    ...(finding.confidence === "uncertain" ? [{ value: "later" as const, label: "先放着" }] : []),
    { value: "merge", label: "合并" }, { value: "notDuplicate", label: "不合并" },
  ];
  if (finding.kind === "contradiction") return [
    { value: "coexist", label: "并列保留" },
    { value: "preferFirst", label: "以前者为准" }, { value: "preferSecond", label: "以后者为准" },
  ];
  if (finding.kind === "nearDomain") return [
    { value: "mergeDomains", label: "合并领域" }, { value: "separateDomains", label: "保持分开" },
  ];
  return [{ value: "verify", label: "标记待核实" }];
}
