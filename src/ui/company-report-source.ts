import { setIcon } from "obsidian";
import { ownedEl } from "./owned-dom";
import { companyReportSourceLabel, type CompanyReportSource } from "../company/report-presentation";

/** The button can live in a desktop name row while its details stay below the header. */
export function renderCompanyReportSource(input: {
  buttonParent: HTMLElement; detailParent: HTMLElement; sources: readonly CompanyReportSource[];
  open: Map<string, boolean>; key: string; english?: boolean; mobile?: boolean; onToggle?: () => void;
}): void {
  const { buttonParent, detailParent, sources, key, open, english } = input;
  if (!sources.length) return;
  const document = buttonParent.ownerDocument;
  const button = ownedEl(document, "button"); button.type = "button";
  button.className = `echoink-report-source${input.mobile ? " is-mobile" : ""}${sources.some(source => source.report.outcome === "failed") ? " is-failed" : ""}`;
  button.dataset.reportSource = key;
  const label = ownedEl(document, "span"); label.textContent = companyReportSourceLabel(sources, english);
  const arrow = ownedEl(document, "span"); arrow.className = "echoink-report-chevron"; arrow.setAttribute("aria-hidden", "true"); setIcon(arrow, "chevron-right");
  button.append(label, arrow); buttonParent.append(button);
  const details = ownedEl(document, "div"); details.className = "echoink-report-details";
  // Source identity remains stable when the receiving answer first appears or the UI redraws.
  details.id = `company-report-${encodeURIComponent(key)}`;
  button.setAttribute("aria-controls", details.id);
  for (const { report } of sources) {
    const section = ownedEl(document, "div"); section.className = "echoink-report-item";
    const fields = [[english ? "Task" : "任务", report.task], [english ? "Summary" : "摘要", report.summary],
      ...(report.outputs ? [[english ? "Outputs" : "产出", report.outputs]] : []),
      ...(report.question ? [[english ? "Problem" : "问题", report.question]] : []),
      [english ? "Task ID" : "任务编号", report.taskId]];
    for (const [name, value] of fields) {
      const line = ownedEl(document, "div"), title = ownedEl(document, "span");
      line.className = name === "任务编号" || name === "Task ID" ? "echoink-report-id" : "";
      title.className = "echoink-report-field"; title.textContent = name;
      line.append(title, document.createTextNode(value)); section.append(line);
    }
    details.append(section);
  }
  detailParent.append(details);
  const sync = () => { const expanded = open.get(key) ?? false; details.hidden = !expanded; button.setAttribute("aria-expanded", String(expanded)); };
  sync();
  button.addEventListener("click", () => { open.set(key, !(open.get(key) ?? false)); sync(); input.onToggle?.(); });
}
