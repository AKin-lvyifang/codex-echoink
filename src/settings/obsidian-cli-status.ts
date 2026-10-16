import { Platform } from "obsidian";
import { OriginSetting } from "./origin-setting";
import { applySettingsRow } from "./settings-v2";

interface CliHost {
  remote?: { app?: { getVersion?(): string } };
  ipcRenderer?: { sendSync(channel: "version" | "cli", value?: null): unknown };
}

export type ObsidianCliStatus = "enabled" | "disabled" | "update-installer" | "update-app" | "unknown";

function supportsCli(version: unknown): boolean | undefined {
  if (typeof version !== "string") return undefined;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/u.exec(version);
  if (!match) return undefined;
  const [, major, minor, patch] = match.map(Number);
  return major > 1 || (major === 1 && (minor > 12 || (minor === 12 && patch >= 7)));
}

export function readObsidianCliStatus(host: CliHost | undefined): ObsidianCliStatus {
  try {
    if (supportsCli(host?.remote?.app?.getVersion?.()) === false) return "update-installer";
    const ipc = host?.ipcRenderer;
    const supported = supportsCli(ipc?.sendSync("version"));
    if (supported === false) return "update-app";
    if (!supported || !ipc) return "unknown";
    // Same read used by Obsidian General settings. null reads the switch;
    // never send a boolean, which would change the host's configuration.
    // This host bridge is not public API: missing/changed results stay unknown.
    const enabled = ipc.sendSync("cli", null);
    return enabled === true ? "enabled" : enabled === false ? "disabled" : "unknown";
  } catch {
    return "unknown";
  }
}

export function renderObsidianCliStatus(container: HTMLElement, zh: boolean): void {
  if (!Platform.isDesktopApp) return;
  const host = (window as Window & { electron?: CliHost }).electron;
  const status = readObsidianCliStatus(host);
  const row = applySettingsRow(new OriginSetting(container)
    .setName(zh ? "Obsidian 原生 CLI" : "Obsidian CLI")
    .setDesc(zh ? "开启后，Agent 可调用更多 Obsidian 原生能力。" : "Lets the agent use more native Obsidian capabilities."));
  row.settingEl.addClass("echoink-obsidian-cli-status");
  const labels: Record<ObsidianCliStatus, string> = zh ? {
    enabled: "已开启", disabled: "未开启", "update-installer": "需更新安装包", "update-app": "需更新 Obsidian", unknown: "状态未知"
  } : {
    enabled: "Enabled", disabled: "Not enabled", "update-installer": "Update installer", "update-app": "Update Obsidian", unknown: "Status unknown"
  };
  if (status === "enabled") {
    row.controlEl.createSpan({ text: labels[status], cls: "setting-item-description" });
  } else {
    const needsUpdate = status === "update-installer" || status === "update-app";
    row.controlEl.createEl("a", {
      text: labels[status], cls: "external-link text-button",
      attr: {
        href: needsUpdate ? "https://obsidian.md/download" : "https://obsidian.md/help/cli",
        target: "_blank", rel: "noopener noreferrer",
        title: needsUpdate
          ? (zh ? "需要 Obsidian 1.12.7 以上安装包" : "Requires Obsidian installer 1.12.7 or later")
          : (zh ? "在 Obsidian 设置 → 通用中查看并开启命令行界面" : "Check Command line interface in Obsidian Settings → General")
      }
    });
  }
}
