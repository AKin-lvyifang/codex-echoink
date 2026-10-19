import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const allowed = await realpath(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时"));
assert.ok(process.env.ECHOINK_AGENT_SETTINGS_TEST_ROOT, "Explicit ECHOINK_AGENT_SETTINGS_TEST_ROOT is required");
const requested = path.resolve(process.env.ECHOINK_AGENT_SETTINGS_TEST_ROOT);
assert.ok(requested.startsWith(allowed + path.sep), "Use disposable test Vaults");
await mkdir(requested, { recursive: true });
const testRoot = await realpath(requested);
assert.ok(testRoot.startsWith(allowed + path.sep), "Fixture symlinks must stay in disposable test Vaults");
const temporary = await mkdtemp(path.join(testRoot, "run-"));
try {
  const output = path.join(temporary, "agent-settings.mjs");
  await esbuild.build({ stdin: { contents: 'import { runAgentSettingsTests } from "./src/tests/agent-settings"; await runAgentSettingsTests();', resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node22", outfile: output,
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    banner: { js: `import {createRequire} from "node:module"; const require = createRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    plugins: [{ name: "host-fixtures", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^(jsdom|yaml|@earendil-works\/pi-(agent-core|ai|coding-agent)(\/.*)?)$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }));
    } }], logLevel: "silent" });
  await import(pathToFileURL(output).href);
} finally { await rm(temporary, { recursive: true, force: true }); }
