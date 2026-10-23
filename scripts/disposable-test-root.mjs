import path from "node:path";
import { homedir } from "node:os";

/** Keep explicit fixture overrides inside the registered disposable Vault tree. */
export function disposableTestRoot(fallback, envNames = []) {
  const selected = [...envNames, "ECHOINK_TEST_ROOT"].map(name => process.env[name]?.trim()).find(Boolean);
  const root = path.resolve(selected || fallback);
  const base = path.join(homedir(), "EchoInk-TestVaults/90-任务临时");
  if (root !== base && !root.startsWith(base + path.sep)) throw new Error("Test fixtures must stay inside EchoInk-TestVaults/90-任务临时");
  return root;
}

/** Preserve historical defaults while allowing an explicitly isolated output root. */
export function disposableTestOutputRoot(fallback) {
  return process.env.ECHOINK_TEST_ROOT?.trim() ? disposableTestRoot(fallback) : fallback;
}
