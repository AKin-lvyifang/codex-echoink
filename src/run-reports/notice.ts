import { ownedFragment, ownedSpan, ownedDiv, ownedEl } from "../ui/owned-dom";
/** Notice contents only: clicking opens a review form; it never uploads automatically. */
export function settingsReportNoticeContent(doc: Document, message: string, openReport: () => void | Promise<void>, english = false, mobile = false): DocumentFragment {
  const fragment = ownedFragment(doc);
  const text = ownedSpan(doc); text.textContent = message; fragment.append(text);
  const actions = ownedDiv(doc); actions.className = `echoink-run-report-notice-actions${mobile ? " is-mobile" : ""}`;
  const button = ownedEl(doc, "button"); button.type = "button"; button.className = "echoink-run-report-notice-action";
  button.textContent = english ? "Report a problem" : "上报问题";
  button.onclick = () => {
    if (button.disabled) return; button.disabled = true;
    void Promise.resolve().then(openReport).catch(error => {
      const reason = ownedDiv(doc); reason.textContent = error instanceof Error ? error.message : english ? "Could not open report" : "无法打开上报问题";
      actions.append(reason);
    }).finally(() => { button.disabled = false; });
  };
  actions.append(button); fragment.append(actions); return fragment;
}
