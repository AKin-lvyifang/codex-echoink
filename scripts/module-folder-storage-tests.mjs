import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const repo = fileURLToPath(new URL("../", import.meta.url));
const configured = process.env.ECHOINK_MODULES_TEST_ROOT;
if (!configured) throw new Error("Set ECHOINK_MODULES_TEST_ROOT to the registered P12 automatic-test root.");
const temporaryVaults = await realpath(path.join(homedir(), "EchoInk-TestVaults/90-任务临时"));
const root = await realpath(configured);
const relativeFixture = path.relative(temporaryVaults, root);
if (!relativeFixture || relativeFixture === ".." || relativeFixture.startsWith(`..${path.sep}`) || path.isAbsolute(relativeFixture) || !(await stat(root)).isDirectory()) {
  throw new Error("Module folder fixtures must use an existing directory inside EchoInk-TestVaults/90-任务临时");
}
const run = await mkdtemp(path.join(root, "module-folder-storage-"));
try {
  const output = path.join(run, "tests.mjs");
  await esbuild.build({
    stdin: { contents: 'export { runModuleFolderStorageTests } from "./src/tests/module-folder-storage"; export { runKnowledgeFolderPlanTests } from "./src/tests/knowledge-folder-plans";', resolveDir: repo, sourcefile: "module-folder-storage-entry.ts", loader: "ts" },
    bundle: true, platform: "node", target: "node22", format: "esm", outfile: output,
    banner: { js: `import {createRequire as createModuleFolderRequire} from "node:module"; const require = createModuleFolderRequire(${JSON.stringify(path.join(repo, "package.json"))});` },
    loader: { ".md": "text", ".svg": "text", ".webp": "dataurl", ".txt": "text" },
    plugins: [{ name: "offline-host", setup(build) {
      build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(repo, "src/tests/origin-controls-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path === "obsidian") return { path: path.join(repo, "src/tests/obsidian-shim.ts") };
        if (args.path === "electron") return { path: args.path, external: true };
        const resolved = import.meta.resolve(args.path);
        return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
      });
    } }], logLevel: "silent"
  });
  const tests = await import(pathToFileURL(output).href);
  await mkdir(path.join(run, "fixtures"));
  await tests.runModuleFolderStorageTests(path.join(run, "fixtures"));
  await tests.runKnowledgeFolderPlanTests();
} finally { await rm(run, { recursive: true, force: true }); }
