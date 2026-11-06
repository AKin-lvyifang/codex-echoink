import { fileURLToPath } from "node:url";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { disposableTestRoot } from "./disposable-test-root.mjs";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const testRoot = process.env.ECHOINK_MEMORY_TEST_ROOT || process.env.ECHOINK_TEST_ROOT;
if (!testRoot) throw new Error("Set an explicit disposable ECHOINK_MEMORY_TEST_ROOT or ECHOINK_TEST_ROOT");
const outputRoot = await realpath(disposableTestRoot(testRoot, ["ECHOINK_MEMORY_TEST_ROOT"]));
if (await realpath(process.env.TMPDIR || "") !== outputRoot) throw new Error("TMPDIR must match ECHOINK_MEMORY_TEST_ROOT");
const result = await esbuild.build({
  stdin: {
    contents: 'import { runMemoryDirectoryIntegrationTests } from "./src/tests/memory-directory-integration"; await runMemoryDirectoryIntegrationTests();',
    resolveDir: root,
    loader: "ts"
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "silent",
  loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
  banner: { js: `import {createRequire as createMemoryDirectoryRequire} from "node:module"; const require = createMemoryDirectoryRequire(${JSON.stringify(path.join(root, "package.json"))});` },
  plugins: [{ name: "memory-directory-host", setup(build) {
    build.onResolve({ filter: /^(?:@earendil-works\/pi-(?:agent-core|ai|coding-agent)(?:\/.*)?|yaml|jsdom)$/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
  } }]
});
try {
  await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
} catch (error) {
  console.error(`${error?.name ?? "Error"}: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
}
