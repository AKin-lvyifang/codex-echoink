import { describeSnapshot, RUN_REPORT_LIMIT, type ReportSnapshot } from "./report";

export interface ReportFormOptions {
  document: Document; snapshot: ReportSnapshot; english?: boolean;
  button: (parent: HTMLElement, label: string, action: () => void, primary?: boolean) => HTMLButtonElement;
  upload: (snapshot: ReportSnapshot) => Promise<string>; export: (snapshot: ReportSnapshot) => Promise<void>;
}
export function createRunReportForm(options: ReportFormOptions): { content: HTMLElement; footer: HTMLElement; dispose: () => void } {
  const { document: doc, snapshot, button } = options;
  const t = (zh: string, en: string) => options.english ? en : zh;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => { const node = doc.createElement(tag); node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const content = el("div", "echoink-run-report-form"), footer = el("div", "echoink-run-report-footer");
  const descriptionLabel = el("label", "echoink-run-report-field", t("问题描述", "Problem description"));
  const description = el("textarea", "echoink-run-report-input"); description.required = true; description.minLength = 5; description.placeholder = t("请描述遇到的问题（至少 5 个字）", "Describe the problem (at least 5 characters)"); description.rows = 4; descriptionLabel.append(description);
  const contactLabel = el("label", "echoink-run-report-field", t("联系方式（选填）", "Contact (optional)"));
  const contact = el("input", "echoink-run-report-input"); contact.type = "text"; contactLabel.append(contact);
  const disclosure = el("p", "echoink-run-report-disclosure", t("主动上传到 echoink.cn，包含对话内容、读到的笔记片段和运行日志。已自动隐藏识别到的密钥，请检查上传内容。", "Uploads to echoink.cn, including conversations, note excerpts and run logs. Recognized secrets are hidden automatically; please review the content."));
  const details = el("details", "echoink-run-report-preview"), summary = el("summary", "", t("查看将上传的内容", "Review upload content"));
  const preview = el("pre", "echoink-run-report-json"); preview.tabIndex = 0; details.append(summary, preview);
  content.append(descriptionLabel, contactLabel, disclosure, details);
  const status = el("div", "echoink-run-report-result"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const actions = el("div", "echoink-run-report-actions"); footer.append(status, actions);
  let current = snapshot, busy = false, disposed = false, succeeded = false, fallbackOffered = false;
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
  const fallback = button(actions, t("改为导出文件", "Export file instead"), () => {
    if (busy || disposed) return;
    busy = true; update(); void options.export(current).then(() => { if (!disposed) status.textContent = t("已导出运行记录", "Run report exported"); }).catch(error => { if (!disposed) status.textContent = errorText(error); }).finally(() => { busy = false; if (!disposed) update(); });
  }); fallback.hidden = true;
  const submit = button(actions, t("上报", "Submit report"), () => {
    if (busy || disposed || succeeded || current.bytes > RUN_REPORT_LIMIT || [...description.value.trim()].length < 5 || [...description.value].length > 2000) return;
    busy = true; status.textContent = ""; update();
    void options.upload(current).then(id => {
      if (disposed) return; succeeded = true; content.hidden = true; submit.hidden = true; fallback.hidden = true;
      status.textContent = `${t("上报成功", "Report submitted")} · ${id}`;
      button(actions, t("复制编号", "Copy ID"), () => {
        void Promise.resolve().then(() => { const clipboard = doc.defaultView?.navigator.clipboard; if (!clipboard) throw new Error("Clipboard unavailable"); return clipboard.writeText(id); }).then(() => { if (!disposed) status.textContent = `${id} · ${t("已复制", "Copied")}`; }).catch(() => { if (!disposed) status.textContent = `${id} · ${t("复制失败，请手动复制", "Copy failed; please copy manually")}`; });
      });
    }).catch(error => { if (!disposed) { status.textContent = errorText(error); fallbackOffered = true; } }).finally(() => { busy = false; if (!disposed) update(); });
  }, true);
  const update = (): void => {
    description.disabled = contact.disabled = busy || succeeded;
    fallback.hidden = succeeded || !fallbackOffered; fallback.disabled = busy;
    submit.disabled = busy || succeeded || current.bytes > RUN_REPORT_LIMIT || [...description.value.trim()].length < 5 || [...description.value].length > 2000;
    submit.textContent = busy ? t("处理中…", "Working…") : t("上报", "Submit report"); submit.setAttribute("aria-busy", String(busy));
  };
  const input = (): void => {
    current = describeSnapshot(snapshot, description.value, contact.value);
    if (details.open) preview.textContent = current.json;
    if (current.bytes > RUN_REPORT_LIMIT) { status.textContent = t("运行记录超过 8 MiB，请改为导出文件。", "Report exceeds 8 MiB. Please export the file."); fallbackOffered = true; }
    else if (!busy) status.textContent = "";
    update();
  };
  description.addEventListener("input", input); contact.addEventListener("input", input);
  details.addEventListener("toggle", () => { if (details.open) preview.textContent = current.json; });
  input();
  return { content, footer, dispose: () => { disposed = true; } };
}
