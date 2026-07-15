import { Platform } from "obsidian";

type ElectronRequire = (moduleName: string) => unknown;

export interface ElectronShell {
  showItemInFolder(filePath: string): void;
  openPath(filePath: string): Promise<string> | string;
}

export interface ElectronOpenDialogResult {
  canceled?: boolean;
  filePaths?: string[];
}

export interface ElectronDialog {
  showOpenDialog(options: {
    title?: string;
    defaultPath?: string;
    properties?: string[];
  }): Promise<ElectronOpenDialogResult>;
}

interface ElectronModule {
  shell?: ElectronShell;
  dialog?: ElectronDialog;
  remote?: {
    dialog?: ElectronDialog;
  };
}

export function getElectronShell(): ElectronShell | null {
  if (!Platform.isDesktopApp) return null;
  return electronModule()?.shell ?? null;
}

export function getElectronDialog(): ElectronDialog | null {
  if (!Platform.isDesktopApp) return null;
  const electron = electronModule();
  return electron?.remote?.dialog ?? electron?.dialog ?? null;
}

export function showItemInFinder(filePath: string): boolean {
  if (!filePath) return false;
  const shell = getElectronShell();
  if (!shell?.showItemInFolder) return false;
  shell.showItemInFolder(filePath);
  return true;
}

export async function openPathInElectron(filePath: string): Promise<boolean> {
  if (!filePath) return false;
  const shell = getElectronShell();
  if (!shell?.openPath) return false;
  const result = await shell.openPath(filePath);
  return typeof result !== "string" || result.length === 0;
}

function electronModule(): ElectronModule | null {
  const electronRequire = (window as typeof window & { require?: ElectronRequire }).require
    ?? (globalThis as typeof globalThis & { require?: ElectronRequire }).require;
  try {
    return (electronRequire?.("electron") as ElectronModule | undefined) ?? null;
  } catch {
    return null;
  }
}
