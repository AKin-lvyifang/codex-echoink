import { setIcon } from "obsidian";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "../settings/amicro-buttons";
import { showSettingsInlineConfirmation } from "../settings/settings-v2";
import type { VaultMemoryNotice } from "../storage/vault-identity";

export function renderVaultMemoryBanner(host: HTMLElement, notice: VaultMemoryNotice | null, language: string, actions: {
  resolve(action: "adopt" | "reset"): Promise<void>; error(error: unknown): void;
}): void {
  const signature = JSON.stringify([notice, language]);
  if (host.dataset.signature === signature) return;
  disposeOriginControls(host); host.empty(); host.dataset.signature = signature;
  if (!notice) return;
  const t = (zh: string, en: string) => language === "en" ? en : zh;
  const panel = host.createDiv({ cls: "wb-memory-notice", attr: { role: "status" } });
  const row = panel.createDiv({ cls: "wb-memory-notice-row" });
  const icon = row.createSpan({ cls: "wb-lead is-warning", attr: { "aria-hidden": "true" } });
  setIcon(icon, "circle-alert");
  const copy = row.createDiv({ cls: "wb-grow" });
  copy.createDiv({ text: t("这份记忆不属于当前库，暂时没有读取。", "This memory does not belong to this vault and has not been loaded.") });
  const details = copy.createEl("details");
  details.createEl("summary", { text: t("查看原因", "Details") });
  details.createDiv({ text: notice.reason });
  const controls = row.createDiv({ cls: "wb-memory-notice-actions" });
  let busy = false;
  const run = async (trigger: HTMLButtonElement, pending: string, operation: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>("button"));
    buttons.forEach(button => { button.disabled = true; });
    const originalText = trigger.textContent;
    trigger.textContent = pending;
    setAmicroButtonPending(trigger, true);
    panel.setAttribute("aria-busy", "true");
    try { await operation(); } catch (error) { actions.error(error); }
    finally {
      busy = false; panel.removeAttribute("aria-busy");
      buttons.forEach(button => { button.disabled = false; });
      setAmicroButtonPending(trigger, false);
      trigger.textContent = originalText;
    }
  };
  const button = (text: string, variant: "primary" | "secondary") => {
    const node = createOriginButton(controls, { text, cls: `wb-button is-${variant}`, attr: { type: "button" } });
    applyAmicroButton(node, { variant }); return node;
  };
  const reset = button(t("重新建立", "Start fresh"), "secondary");
  reset.onclick = () => {
    if (busy) return;
    showSettingsInlineConfirmation(panel, reset, {
      message: t("把这份记忆移到备份，为这个库新建一份？", "Move this memory to a backup and start fresh in this vault?"),
      cancelLabel: t("取消", "Cancel"), confirmLabel: t("重新建立", "Start fresh"), danger: false,
      onConfirm: async () => {
        const confirm = panel.querySelector<HTMLButtonElement>(".review-confirm button:last-child")!;
        try { await run(confirm, t("正在重新建立…", "Starting fresh…"), () => actions.resolve("reset")); }
        finally { row.hidden = false; }
      }
    });
    const confirmation = panel.querySelectorAll<HTMLButtonElement>(".review-confirm button");
    confirmation.forEach((node, index) => {
      const variant = index === confirmation.length - 1 ? "primary" : "secondary";
      node.addClass("wb-button", `is-${variant}`); applyAmicroButton(node, { variant });
    });
    row.hidden = true;
    confirmation[0]?.addEventListener("click", () => { row.hidden = false; });
  };
  const primary = button(t("沿用这份记忆", "Use this memory"), "primary");
  primary.onclick = () => { void run(primary, t("正在恢复…", "Restoring…"), () => actions.resolve("adopt")); };
}
