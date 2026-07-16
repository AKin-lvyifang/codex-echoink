import {
  CODEX_NPM_INSTALL_ARGS,
  installNpmCli,
  type NpmCliInstallErrorKind,
  type NpmCliInstallOptions,
  type NpmCliInstallStatus,
  type NpmCliRunner,
  type NpmCliRunnerOptions
} from "./npm-cli-installer";

export { CODEX_NPM_INSTALL_ARGS };

export type CodexInstallErrorKind = NpmCliInstallErrorKind;
export type CodexInstallStatus = NpmCliInstallStatus;
export type CodexInstallRunnerOptions = NpmCliRunnerOptions;
export type CodexInstallRunner = NpmCliRunner;
export type CodexInstallOptions = NpmCliInstallOptions;

export interface CodexInstallResult {
  status: CodexInstallStatus;
  command: string | null;
  version: string | null;
  logs: string;
  errorKind?: CodexInstallErrorKind;
  error?: string;
}

export async function installCodexCli(options: CodexInstallOptions = {}): Promise<CodexInstallResult> {
  const { kind: _kind, ...result } = await installNpmCli("codex", options);
  return result;
}
