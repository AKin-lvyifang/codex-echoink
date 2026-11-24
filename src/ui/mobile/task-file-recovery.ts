import type { MobileStore } from "../../mobile/store";
import { shellElement } from "./shell-controls";

interface TaskFileRecoveryHost {
  store: MobileStore;
  reloadTaskFile?: () => Promise<void>;
  settings(): { settingsLanguage?: string };
}

export function createTaskFileRecovery(document: Document, host: TaskFileRecoveryHost,
  buildButton: (label: string, action: () => void) => HTMLButtonElement) {
  const reload = host.reloadTaskFile;
  if (!reload) return undefined;
  const element = shellElement(document, "div", "echoink-task-file-recovery");
  const text = shellElement(document, "span", "");
  text.setAttribute("role", "alert");
  const copy = (zh: string, en: string) => host.settings().settingsLanguage === "en" ? en : zh;
  let pending = false, failed = false;
  const button = buildButton(copy("重新加载任务", "Reload tasks"), () => { void recover(); });
  element.append(text, button);
  const render = () => {
    element.hidden = !(host.store.taskFileChanged || pending || failed);
    text.textContent = pending ? copy("正在重新加载任务…", "Reloading tasks…")
      : failed ? copy("暂时读不到任务记录，请稍后重试。", "Tasks are temporarily unavailable. Try again shortly.")
      : copy("任务记录在别处更新了，请重新加载后继续。", "Tasks were updated elsewhere. Reload them to continue.");
    button.disabled = pending;
  };
  const recover = async () => {
    if (pending) return;
    pending = true; failed = false; render();
    try { await reload(); }
    catch { failed = true; }
    finally { pending = false; render(); }
  };
  const dispose = host.store.subscribeTaskFile(render);
  render();
  return { element, dispose };
}
