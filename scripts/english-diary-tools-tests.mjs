import { disposableTestRoot } from "./disposable-test-root.mjs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = disposableTestRoot(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时/工作台P9自动测试-20261019"));
await mkdir(fixtureRoot, { recursive: true });
const directory = await mkdtemp(path.join(fixtureRoot, "english-tools-"));
try {
  const target = path.join(directory, "tests.mjs");
  await esbuild.build({
    stdin: { contents: [
      'import { runEnglishDiaryToolTests } from "./src/tests/pi-native/english-diary-tools";',
      'import { runEnglishDiaryServiceTests } from "./src/tests/english-diary-service";',
      'import { runEnglishDiaryRepositoryTests } from "./src/tests/english-diary-repository";',
      `await runEnglishDiaryToolTests(${JSON.stringify(path.join(directory, "fixtures"))});`,
      'await runEnglishDiaryServiceTests(); console.log("Existing English diary service/privacy regressions: PASS");',
      'await runEnglishDiaryRepositoryTests(); console.log("Existing English diary repository regressions: PASS");'
    ].join("\n"), resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", format: "esm", outfile: target,
    banner: { js: `import {createRequire} from "node:module"; const require = createRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    plugins: [{ name: "pi-runtime-from-workspace", setup(build) { build.onResolve({ filter: /^@earendil-works\// }, args => ({ path: import.meta.resolve(args.path), external: true })); } }],
    alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") }, loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" }
  });
  const run = spawnSync(process.execPath, [target], { cwd: root, env: { ...process.env, PI_OFFLINE: "1" }, stdio: "inherit" });
  if (run.status !== 0) process.exitCode = run.status ?? 1;
} finally { await rm(directory, { recursive: true, force: true }); }
