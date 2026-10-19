import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const configuredRoot = process.env.ECHOINK_USER_PROFILE_TEST_ROOT;
const authorizedParent = path.join(homedir(), "EchoInk-TestVaults", "90-任务临时");
if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
  throw new Error("Set ECHOINK_USER_PROFILE_TEST_ROOT to an explicit disposable test directory");
}
const testRoot = path.resolve(configuredRoot);
if (!testRoot.startsWith(`${authorizedParent}${path.sep}`) || path.basename(testRoot) !== "runtime") {
  throw new Error("Profile control test root must be a runtime subdirectory under EchoInk-TestVaults/90-任务临时");
}
if (!(await lstat(path.dirname(testRoot))).isDirectory()) throw new Error("Registered test parent is missing");
await mkdir(testRoot, { recursive: true });
if (await realpath(testRoot) !== testRoot) throw new Error("Test root must not contain symlinks");
const runRoot = await mkdtemp(path.join(testRoot, "user-profile-control-"));
try {
  const outputFile = path.join(runRoot, "user-profile-control-tests.mjs");
  await esbuild.build({
    stdin: {
      contents: 'import { runUserProfileControlScenarios } from "./src/tests/user-profile-control"; await runUserProfileControlScenarios();',
      resolveDir: rootDir, sourcefile: "user-profile-control-test-entry.ts", loader: "ts"
    },
    bundle: true, platform: "node", target: "node22", format: "esm",
    loader: { ".md": "text", ".webp": "dataurl" },
    outfile: outputFile, logLevel: "silent"
  });
  const result = spawnSync(process.execPath, [outputFile], {
    cwd: rootDir, env: { ...process.env, PI_OFFLINE: "1", ECHOINK_USER_PROFILE_TEST_RUN_ROOT: runRoot }, stdio: "inherit"
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(runRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
