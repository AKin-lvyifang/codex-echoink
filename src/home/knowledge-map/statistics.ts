import { createOriginButton, disposeOriginControls } from "../../settings/origin-controls";
import type { KnowledgePageSnapshot } from "../knowledge-page-core";

export function knowledgeHealthScore(
  data: Pick<KnowledgePageSnapshot, "health" | "directories">,
): number | null {
  const health = data.health;
  return health &&
    ["local-structure", "limited"].includes(health.assessment) &&
    health.status !== "unknown"
    ? health.score
    : null;
}

export function renderKnowledgeStatistics(
  host: HTMLElement,
  data: Pick<KnowledgePageSnapshot, "health" | "directories" | "weekly" | "pendingCount">,
  english: boolean,
  openHealth: () => void,
  openInbox: () => void,
): void {
  const retained = Array.from(
    host.querySelectorAll<HTMLElement>(".activity-heatmap-controls, .activity-heatmap-period"),
  );
  retained.forEach((element) => element.remove());
  disposeOriginControls(host);
  host.empty();
  const score = knowledgeHealthScore(data);
  const values = [
    [english ? "Knowledge health" : "知识健康", score, ""],
    [english ? "Pending" : "待处理", data.pendingCount ?? null, ""],
    [english ? "Added this week" : "本周新增", data.weekly.added, english ? "notes" : "篇"],
    [
      english ? "Organized this week" : "本周整理",
      data.weekly.organized,
      english ? "batches" : "次",
    ],
    [
      english ? "Inbox" : "收件箱",
      data.directories.find((directory) => directory.role === "inbox")?.count ?? null,
      "",
    ],
  ] as const;
  values.forEach(([label, value, unit], index) => {
    const item = [0, 1, 4].includes(index)
      ? createOriginButton(host, { cls: "knowledge-button is-tertiary knowledge-metric" })
      : host.createDiv({ cls: "knowledge-metric" });
    if ([0, 1, 4].includes(index)) {
      const button = item as HTMLButtonElement;
      button.onclick = index === 4 ? openInbox : openHealth;
      button.setAttribute("aria-label", label);
    }
    item.createSpan({ text: label });
    const number = item.createSpan({ cls: "knowledge-metric-number" });
    number.createEl("strong", { text: value === null ? "—" : String(value) });
    if (unit) number.createSpan({ text: unit });
  });
  host.append(...retained);
}
