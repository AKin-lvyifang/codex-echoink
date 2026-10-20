import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const allowed = await realpath(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时"));
const testRoot = process.env.ECHOINK_TODO_TEST_ROOT ? await realpath(process.env.ECHOINK_TODO_TEST_ROOT) : null;
if (testRoot && !testRoot.startsWith(allowed + path.sep)) throw new Error("Fixtures must stay in 90-任务临时");
const directory = testRoot ? await mkdtemp(path.join(testRoot, "reminders-")) : path.join(root, ".tmp");
const output = path.join(directory, "todo-reminder-tests.mjs");
await mkdir(path.dirname(output), { recursive: true });
try {
  await esbuild.build({
    stdin: {
      contents: 'import { runHomeTodoTests } from "./src/tests/home-todos"; import { runTodoReminderTests } from "./src/tests/todo-reminders"; await runHomeTodoTests(); console.log("To-do targeted regression: PASS"); await runTodoReminderTests();',
      resolveDir: root,
      sourcefile: "todo-reminder-test-entry.ts",
      loader: "ts"
    },
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    banner: { js: `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "yaml", "jsdom"],
    plugins: [{
      name: "todo-host-shims",
      setup(build) {
        build.onResolve({ filter: /^(@earendil-works\/|yaml$|jsdom$)/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }));
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
        build.onResolve({ filter: /provider-brand-icons$/ }, () => ({ path: path.join(root, "src/tests/composer-provider-brand-shim.ts") }));
      }
    }],
    outfile: output,
    logLevel: "silent"
  });
  const result = spawnSync(process.execPath, [output], { cwd: root, env: { ...process.env, PI_OFFLINE: "1" }, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(output, { force: true });
  if (testRoot) await rm(directory, { recursive: true, force: true });
}
