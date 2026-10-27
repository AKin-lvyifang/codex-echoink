import { appendFileSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const environmentFile = process.env.GITHUB_ENV;
if (!environmentFile) throw new Error("GITHUB_ENV is required to publish the CI fixture paths.");
const vaultsRoot = path.join(homedir(), "EchoInk-TestVaults");
const temporaryRoot = path.join(vaultsRoot, "90-任务临时");
mkdirSync(temporaryRoot, { recursive: true });
const fixtureRoot = mkdtempSync(path.join(temporaryRoot, "ci-release-"));
symlinkSync(path.join(process.cwd(), "node_modules"), path.join(fixtureRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
appendFileSync(path.join(vaultsRoot, "README.md"),
  `\n- \`90-任务临时/${path.basename(fixtureRoot)}\`: isolated synthetic CI fixtures; removed with the disposable runner.\n`);
const environment = {
  TMPDIR: fixtureRoot,
  ECHOINK_TEST_ROOT: fixtureRoot,
  ECHOINK_MEMORY_TEST_ROOT: fixtureRoot,
  ECHOINK_SETTINGS_TEST_ROOT: fixtureRoot,
  ECHOINK_KNOWLEDGE_TEST_ROOT: fixtureRoot
};
appendFileSync(environmentFile, Object.entries(environment).map(([key, value]) => `${key}=${value}\n`).join(""));
console.log(`Prepared isolated CI test Vault: ${fixtureRoot}`);
