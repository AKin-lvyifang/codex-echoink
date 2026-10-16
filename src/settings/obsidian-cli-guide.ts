import { Platform, setIcon } from "obsidian";
import { createSettingsSection } from "./settings-v2";

export function renderObsidianCliGuide(container: HTMLElement, zh: boolean): void {
  if (!Platform.isDesktopApp) return;

  const section = createSettingsSection(container, {
    title: zh ? "Obsidian 原生功能（可选）" : "Obsidian native features (optional)",
    description: zh
      ? "开启后，助手能使用更多 Obsidian 原生功能"
      : "Enable this to let the assistant use more native Obsidian features.",
    surface: "group"
  });
  section.addClass("echoink-obsidian-cli-guide");
  section.createDiv({
    cls: "echoink-settings-section-description",
    text: zh ? "需要 1.12.7 以上安装包" : "Requires Obsidian installer 1.12.7 or later."
  });

  const help = section.createEl("details", { cls: "echoink-finance-import-help" });
  const summary = help.createEl("summary");
  summary.createSpan({ text: zh ? "查看开启步骤" : "How to enable" });
  setIcon(summary.createSpan({
    cls: "echoink-finance-import-help-arrow",
    attr: { "aria-hidden": "true" }
  }), "chevron-right");

  const body = help.createDiv({ cls: "echoink-finance-import-help-body" });
  const steps = zh ? [
    "1. 在 Obsidian「设置 → 通用」查看安装包版本；低于 1.12.7 时，从官网下载并安装新版。应用版本与安装包版本可能不同。",
    "2. 在「设置 → 通用」开启「命令行界面」。",
    "3. 按 Obsidian 提示完成注册，使用时保持 Obsidian 运行。"
  ] : [
    "1. Check the installer version in Obsidian Settings → General. If it is older than 1.12.7, download and install a newer version. The app and installer versions may differ.",
    "2. In Settings → General, turn on Command line interface.",
    "3. Follow Obsidian's registration prompts and keep Obsidian running while using it."
  ];
  for (const step of steps) body.createEl("p", { text: step });

  const links = body.createEl("p");
  links.createEl("a", {
    cls: "external-link text-button",
    text: zh ? "官方开启说明" : "Official setup guide",
    attr: { href: "https://obsidian.md/help/cli", target: "_blank", rel: "noopener noreferrer" }
  });
  links.createSpan({ text: " · " });
  links.createEl("a", {
    cls: "external-link text-button",
    text: zh ? "下载 Obsidian" : "Download Obsidian",
    attr: { href: "https://obsidian.md/download", target: "_blank", rel: "noopener noreferrer" }
  });
}
