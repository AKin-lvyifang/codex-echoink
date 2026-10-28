import { getDesktopFs } from "../../platform/desktop-filesystem";
import { getDesktopPath } from "../../platform/desktop-paths";

import { getElectronDialog } from "../../core/electron";
import type { SettingsLanguage } from "../../settings/settings";
import { conversationUiText } from "./ui-i18n";

const fs = getDesktopFs();
const path = getDesktopPath();

export async function pickWorkspaceDirectory(
  defaultPath: string,
  language: SettingsLanguage = "zh-CN"
): Promise<string | null | undefined> {
  const dialog = getElectronDialog();
  if (!dialog?.showOpenDialog) return undefined;
  const result = await dialog.showOpenDialog({
    title: conversationUiText(language, "选择 Codex 工作区", "Choose Codex workspace"),
    defaultPath: normalizeWorkspacePath(defaultPath) || undefined,
    properties: ["openDirectory", "createDirectory"]
  });
  if (result?.canceled) return null;
  return result?.filePaths?.[0] ?? null;
}

export function workspaceDirectoryExists(value: string): boolean {
  const workspacePath = normalizeWorkspacePath(value);
  if (!workspacePath) return false;
  try {
    return fs.statSync(workspacePath).isDirectory();
  } catch {
    return false;
  }
}

export function normalizeWorkspacePath(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  const withoutFileProtocol = raw.replace(/^file:\/\//, "");
  try {
    return path.resolve(decodeURI(withoutFileProtocol));
  } catch {
    return path.resolve(withoutFileProtocol);
  }
}

export function workspaceDisplayName(workspacePath: string): string {
  const normalized = normalizeWorkspacePath(workspacePath);
  return path.basename(normalized) || normalized;
}

export function isImagePath(filePath: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|heic)$/i.test(filePath);
}

export function absoluteVaultPath(vaultPath: string, relativePath: string): string {
  return `${vaultPath.replace(/\/$/, "")}/${relativePath.replace(/^\//, "")}`;
}
