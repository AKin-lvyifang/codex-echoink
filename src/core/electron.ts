import { Platform } from "obsidian";

type ElectronRequire = (moduleName: string) => unknown;

export interface ElectronShell {
  showItemInFolder(filePath: string): void;
  openPath(filePath: string): Promise<string> | string;
  openExternal?(url: string): Promise<void> | void;
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

export function isSafeExternalHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export async function openExternalInElectron(url: string): Promise<boolean> {
  if (!isSafeExternalHttpUrl(url)) return false;
  const shell = getElectronShell();
  if (!shell?.openExternal) return false;
  await shell.openExternal(url);
  return true;
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

export function isLoopbackHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (hostname === "localhost" || hostname === "::1") return true;
  const octets = hostname.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}
