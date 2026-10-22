import { disposableTestRoot } from "./disposable-test-root.mjs";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { mobileBuildOptions } from "./mobile-build.mjs";
import { runFolderScenarios } from "../tests/mobile-knowledge-folders/scenarios.mjs";

let project = fileURLToPath(new URL("../", import.meta.url));
const registered = disposableTestRoot(path.join(homedir(), "EchoInk-TestVaults/90-任务临时/移动端改版-M12-20261019"));
await fs.mkdir(registered, { recursive: true });
const root = await fs.mkdtemp(path.join(registered, "knowledge-folders-"));
try {
  if (process.argv.includes("--baseline")) {
    const baseline = path.join(root, "baseline-3a45fe63"); await fs.mkdir(baseline);
    const archive = spawnSync("git", ["archive", "3a45fe63"], { cwd: project, maxBuffer: 128 * 1024 * 1024 });
    if (archive.status !== 0) throw new Error("Could not archive the immutable M11 baseline");
    const unpack = spawnSync("tar", ["-x", "-C", baseline], { input: archive.stdout });
    if (unpack.status !== 0) throw new Error("Could not unpack the immutable M11 baseline");
    await fs.symlink(path.join(project, "node_modules"), path.join(baseline, "node_modules"), "dir"); project = baseline;
    console.log("READ-ONLY original test sources: archived 3a45fe63; existing dependencies; all fixtures under the registered M12 root");
  }
  if (process.argv.includes("--desktop")) {
    const target = path.join(root, "desktop.mjs");
    const contents = process.argv.includes("--organization") ? `import {runKnowledgeFolderOrganizationTests} from './src/tests/knowledge-folder-organization'; await runKnowledgeFolderOrganizationTests();` : `import {runKnowledgeFolderPlanTests} from './src/tests/knowledge-folder-plans';
import {runKnowledgeFolderBindingsTests} from './src/tests/knowledge-folder-bindings';
import {runKnowledgeFolderOrganizationTests} from './src/tests/knowledge-folder-organization';
await runKnowledgeFolderPlanTests(); await runKnowledgeFolderBindingsTests(); await runKnowledgeFolderOrganizationTests();`;
    await esbuild.build({ stdin: { contents, resolveDir: project, loader: "ts" },
      outfile: target, bundle: true, platform: "node", format: "esm", logLevel: "silent", loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl", ".txt": "text" },
      banner: { js: `import {createRequire as createMobileFoldersRequire} from 'node:module';const require=createMobileFoldersRequire(${JSON.stringify(path.join(project, "package.json"))});` },
      plugins: [{ name: "desktop-original-folder-tests", setup(build) {
        build.onResolve({ filter: /^electron$/ }, args => ({ path: args.path, external: true }));
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(project, "src/tests/obsidian-shim.ts") }));
        build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(project, "src/tests/origin-controls-shim.ts") }));
        build.onResolve({ filter: /^[^./]/ }, args => { const url = import.meta.resolve(args.path); return { path: url.startsWith("node:") ? url : fileURLToPath(url), external: true }; });
      } }] });
    const run = spawnSync(process.execPath, [target], { stdio: "inherit", env: { ...process.env, TMPDIR: root, ECHOINK_MODULES_TEST_ROOT: root } });
    process.exitCode = run.status ?? 1;
  } else {
    const built = await esbuild.build({ ...mobileBuildOptions("tests/mobile-knowledge-folders/entry.ts"), metafile: true });
    const blocked = Object.keys(built.metafile.inputs).filter(file => /node:|(?:^|\/)root-paths\.ts$|(?:^|\/)initializer\.ts$|initialization-directory-history\.ts$/u.test(file));
    assert.deepEqual(blocked, []);
    assert.ok(Object.values(built.metafile.outputs).flatMap(output => output.imports).every(item => item.external && item.path === "obsidian"));
    const shimBuild = await esbuild.build({ entryPoints: ["tests/mobile/browser-obsidian.ts"], bundle: true, write: false, platform: "browser", format: "cjs", logLevel: "silent" });
    const dom = new JSDOM("<body></body>"), surfaces = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, DOMParser: dom.window.DOMParser };
    const shim = { exports: {} }; vm.runInNewContext(shimBuild.outputFiles[0].text, { module: shim, exports: shim.exports, console, ...surfaces });
    const module = { exports: {} }, context = vm.createContext({ module, exports: module.exports, console, crypto: webcrypto, structuredClone,
      TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, AbortController, URL, URLSearchParams, atob, btoa, setTimeout, clearTimeout, ...surfaces,
      require: name => { assert.equal(name, "obsidian"); return shim.exports; } });
    vm.runInContext(built.outputFiles[0].text, context);
    assert.equal(vm.runInContext("typeof process + ':' + typeof Buffer", context), "undefined:undefined");
    console.log(`PASS browser graph: ${Object.keys(built.metafile.inputs).length} inputs; no Node initializer/root-paths/history; only obsidian external`);
    await runFolderScenarios(module.exports, root);
    dom.window.close();
  }
} finally { await fs.rm(root, { recursive: true }); }
