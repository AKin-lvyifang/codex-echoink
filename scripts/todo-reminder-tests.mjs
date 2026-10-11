import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, ".tmp", "todo-reminder-tests.mjs");
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
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "yaml", "jsdom"],
    plugins: [{
      name: "todo-host-shims",
      setup(build) {
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
}
