import { setIcon, type App } from "obsidian";
import { createOriginCheck, createOriginSelect } from "../../settings/origin-controls";
import type { CheckupSelection } from "../../plugin/knowledge-checkup-service";
import { checkupTitle } from "../../knowledge-base/knowledge-checkup";
import { knowledgeMapIcon } from "../knowledge-map/icon";
import { rowRepair, deepRepairOptions, type CheckupRow } from "./rows";

export type CheckupButton = (
  parent: HTMLElement,
  text: string,
  action: () => unknown,
  variant?: "primary" | "secondary" | "tertiary",
) => HTMLButtonElement;
interface RowActions {
  app: App;
  button: CheckupButton;
  change(): void;
  ignore(): Promise<void>;
  busy: boolean;
  expanded: boolean;
  toggle(): void;
}
export function renderCheckupRow(
  host: HTMLElement,
  item: CheckupRow,
  selection: CheckupSelection,
  actions: RowActions,
) {
  const wrapper = host.createDiv({
    attr: { "data-checkup-id": item.id, "data-checkup-kind": item.kind },
  });
  const row = wrapper.createDiv({ cls: "knowledge-checkup-row" });
  const slot = row.createDiv({ cls: "knowledge-checkup-slot" });
  const repair = rowRepair(item, selection);
  if (repair !== "later") {
    const check = createOriginCheck(slot, { attr: { "aria-label": `修复${item.title}` } });
    check.checked = selection.action !== "later";
    check.disabled = actions.busy;
    check.addEventListener("change", () => {
      selection.action = check.checked ? repair : "later";
      actions.change();
    });
  }
  const name = row.createDiv({ cls: "knowledge-checkup-name" });
  const open = actions.button(
    name,
    item.title,
    () => item.finding ? actions.toggle() : actions.app.workspace.openLinkText(item.path, ""),
    "tertiary",
  );
  open.addClass("knowledge-checkup-note");
  if (item.finding) {
    open.addClass("knowledge-checkup-expand");
    open.setAttribute("aria-expanded", String(actions.expanded));
    const icon = open.createSpan();
    icon.addClass("knowledge-map-chevron");
    setIcon(icon, "chevron-right");
    open.prepend(icon);
  }
  const action = row.createDiv({ cls: "knowledge-checkup-action" });
  if (item.issue?.kind === "broken" && (item.issue.candidates?.length ?? 0) > 1) {
    action.createSpan({ text: `${item.issue.target} →` });
    const options = [
      { value: "", label: "选择目标" },
      ...item.issue.candidates!.map((path) => ({
        value: path,
        label: path.replace(/\.md$/iu, ""),
      })),
    ];
    const select = createOriginSelect(
      action,
      { attr: { "aria-label": `${item.title}的链接目标` } },
      options,
      selection.target ?? "",
      actions.app,
    );
    select.element.disabled = actions.busy;
    select.element.addEventListener("change", () => {
      selection.target = select.element.value || undefined;
      selection.action = selection.target ? "repair" : "later";
      actions.change();
    });
  } else if (item.finding && item.kind !== "outdated") {
    action.addClass("knowledge-checkup-deep-action");
    const select = createOriginSelect(action,
      { attr: { "aria-label": `${item.title}的修法` } },
      deepRepairOptions(item.finding), selection.action === "later"
        ? selection.choice ?? item.recommended : selection.action, actions.app);
    select.element.disabled = actions.busy;
    select.element.addEventListener("change", () => {
      selection.action = select.element.value as CheckupSelection["action"];
      selection.choice = selection.action;
      actions.change();
    });
  } else action.createSpan({ text: item.action });
  const trailing = row.createDiv({ cls: "knowledge-checkup-slot" });
  if (item.issue || item.kind === "outdated") {
    const ignore = actions.button(trailing, "", () => actions.ignore(), "tertiary");
    ignore.addClass("is-icon", "knowledge-checkup-ignore");
    ignore.setAttribute("aria-label", `不再提示：${item.title}`);
    knowledgeMapIcon(ignore, "eye-off");
  }
  const details = wrapper.createDiv({ cls: "knowledge-checkup-evidence" });
  details.hidden = !actions.expanded;
  if (item.finding) {
    details.createDiv({ text: item.finding.reason });
    const evidenceInOrder = item.finding.paths.flatMap(path =>
      item.finding!.evidence.filter(evidence => evidence.path === path));
    for (const evidence of evidenceInOrder) {
      actions.button(
        details,
        checkupTitle(evidence.path),
        () => actions.app.workspace.openLinkText(evidence.path, ""),
        "tertiary",
      );
      details.createEl("blockquote", { text: evidence.quote });
    }
  }
}
