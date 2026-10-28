/** Notice contents only: clicking opens a review form; it never uploads automatically. */
export function settingsReportNoticeContent(doc: Document, message: string, openReport: () => void | Promise<void>, english = false, mobile = false): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const text = doc.createElement("span"); text.textContent = message; fragment.append(text);
  const actions = doc.createElement("div"); actions.className = `echoink-run-report-notice-actions${mobile ? " is-mobile" : ""}`;
  const button = doc.createElement("button"); button.type = "button"; button.className = "echoink-run-report-notice-action";
  button.textContent = english ? "Report a problem" : "上报问题";
  button.onclick = () => {
    if (button.disabled) return; button.disabled = true;
    void Promise.resolve().then(openReport).catch(error => {
      const reason = doc.createElement("div"); reason.textContent = error instanceof Error ? error.message : english ? "Could not open report" : "无法打开上报问题";
      actions.append(reason);
    }).finally(() => { button.disabled = false; });
  };
  actions.append(button); fragment.append(actions); return fragment;
}
