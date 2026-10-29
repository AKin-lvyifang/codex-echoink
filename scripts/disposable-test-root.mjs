import path from "node:path";
import { homedir } from "node:os";

/** Keep explicit fixture overrides inside the registered disposable Vault tree. */
export function disposableTestRoot(fallback, envNames = []) {
  const selected = [...envNames, "ECHOINK_TEST_ROOT"].map(name => process.env[name]?.trim()).find(Boolean);
  const root = path.resolve(selected || fallback);
  const vaults = path.join(homedir(), "EchoInk-TestVaults"), base = path.join(vaults, "90-任务临时");
  const relative = path.relative(vaults, root);
  const acceptanceCopy = /^测试仓库-.+验收$/u.test(relative.split(path.sep)[0]);
  if (!acceptanceCopy && root !== base && !root.startsWith(base + path.sep)) throw new Error("Test fixtures must stay inside a disposable EchoInk acceptance Vault or legacy fixture directory");
  return root;
}

/** Preserve historical defaults while allowing an explicitly isolated output root. */
export function disposableTestOutputRoot(fallback) {
  return process.env.ECHOINK_TEST_ROOT?.trim() ? disposableTestRoot(fallback) : fallback;
}
