import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { disposableTestRoot } from "./disposable-test-root.mjs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const repo = fileURLToPath(new URL("../", import.meta.url));
const root = await realpath(disposableTestRoot(tmpdir()));
const run = await mkdtemp(path.join(root, "folder-renames-"));
try {
  const output = path.join(run, "tests.mjs");
  await esbuild.build({ entryPoints: [path.join(repo, "src/tests/knowledge-folder-renames.ts")],
    bundle: true, platform: "node", target: "node22", format: "esm", outfile: output, logLevel: "silent" });
  const { runKnowledgeFolderRenameTests } = await import(pathToFileURL(output).href);
  runKnowledgeFolderRenameTests();
  const nativeOutput = path.join(run, "native-tests.mjs");
  await esbuild.build({
    stdin: { contents: 'export { runNativeFolderRenameTests } from "./src/tests/native-journal";', resolveDir: repo, loader: "ts" },
    bundle: true, platform: "node", target: "node22", format: "esm", outfile: nativeOutput, logLevel: "silent",
    banner: { js: `import { createRequire as createNativeFolderRequire } from "node:module"; const require = createNativeFolderRequire(${JSON.stringify(path.join(repo, "package.json"))});` },
    loader: { ".md": "text", ".svg": "text", ".webp": "dataurl", ".txt": "text" },
    plugins: [{ name: "native-folder-host", setup(build) {
      build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(repo, "src/tests/origin-controls-shim.ts") }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repo, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => {
        const resolved = import.meta.resolve(args.path);
        return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
      });
    } }]
  });
  const { runNativeFolderRenameTests } = await import(pathToFileURL(nativeOutput).href);
  await runNativeFolderRenameTests();
} finally {
  await rm(run, { recursive: true, force: true });
}
