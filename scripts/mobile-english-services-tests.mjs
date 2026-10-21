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
import { runEnglishScenarios } from "../tests/mobile-english-services/scenarios.mjs";

let project = fileURLToPath(new URL("../", import.meta.url));
const harness = path.join(project, "tests/mobile-knowledge-page-services/dom.mjs");
const registered = path.join(homedir(), "EchoInk-TestVaults/90-任务临时/移动端改版-M14-20261019");
await fs.mkdir(registered, { recursive: true });
const root = await fs.mkdtemp(path.join(registered, "english-services-"));
try {
  if (process.argv.includes("--baseline")) {
    const baseline = path.join(root, "baseline-a7a4daea"); await fs.mkdir(baseline);
    const archive = spawnSync("git", ["archive", "a7a4daea"], { cwd: project, maxBuffer: 128 * 1024 * 1024 });
    if (archive.status !== 0) throw Error("Could not archive immutable M13 baseline");
    const unpack = spawnSync("tar", ["-x", "-C", baseline], { input: archive.stdout });
    if (unpack.status !== 0) throw Error("Could not unpack immutable M13 baseline");
    await fs.symlink(path.join(project, "node_modules"), path.join(baseline, "node_modules"), "dir"); project = baseline;
    console.log("Immutable original test sources: a7a4daea; existing dependencies; all fixtures under registered M14 root");
  }
  if (process.argv.includes("--desktop")) {
    const suites = {
      service: ["english-diary-service", "runEnglishDiaryServiceTests", ""],
      repository: ["english-diary-repository", "runEnglishDiaryRepositoryTests", ""],
      vault: ["english-diary-vault-port", "runEnglishDiaryVaultPortTests", ""],
      navigation: ["english-diary-navigation-data", "runEnglishDiaryNavigationDataTests", ""],
      reading: ["english-diary-reading", "runEnglishDiaryReadingTests", "document"],
      provider: ["english-diary-provider", "runEnglishDiaryProviderTests", "() => {}"]
    };
    const requested = process.argv.find(arg => arg.startsWith("--suite="))?.slice(8);
    for (const [id, [file, fn, argument]] of Object.entries(suites)) {
      if (requested && requested !== id) continue;
      const target = path.join(root, `${id}.mjs`), suiteRoot = path.join(root, id); await fs.mkdir(suiteRoot);
      await esbuild.build({ stdin: { contents: `export {${fn}} from './src/tests/${file}';`, resolveDir: project, loader: "ts" }, outfile: target,
        bundle: true, platform: "node", target: "node22", format: "esm", logLevel: "silent", loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl", ".txt": "text" },
        banner: { js: `import {createRequire as createM14Require} from 'node:module';const require=createM14Require(${JSON.stringify(path.join(project, "package.json"))});` },
        plugins: [{ name: "original-m14-desktop-regressions", setup(build) {
          build.onResolve({ filter: /^electron$/ }, args => ({ path: args.path, external: true }));
          build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(project, "src/tests/obsidian-shim.ts") }));
          if (id !== "provider") build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(project, "src/tests/origin-controls-shim.ts") }));
          build.onResolve({ filter: /^[^./]/ }, args => { const url = import.meta.resolve(args.path); return { path: url.startsWith("node:") ? url : fileURLToPath(url), external: true }; });
        } }] });
      const bootstrap = path.join(root, `${id}-run.mjs`);
      await fs.writeFile(bootstrap, `import {close} from ${JSON.stringify(harness)};const root=${JSON.stringify(suiteRoot)};try{await (await import(${JSON.stringify(target)})).${fn}(${argument});console.log('PASS original ${id}');}finally{close();}`);
      const run = spawnSync(process.execPath, [bootstrap], { stdio: "inherit", env: { ...process.env, TZ: "America/Los_Angeles", TMPDIR: root, ECHOINK_MODULES_TEST_ROOT: root, PI_OFFLINE: "1" } });
      if (run.status !== 0) { console.log(`FAIL original ${id}: exit=${run.status}`); process.exitCode = 1; }
    }
  } else {
    process.env.TZ = "America/Los_Angeles";
    const built = await esbuild.build({ ...mobileBuildOptions("tests/mobile-english-services/entry.ts"), metafile: true });
    const blocked = Object.keys(built.metafile.inputs).filter(file => /node:|(?:^|\/)(?:root-paths|raw-digest|dashboard|source-health|knowledge-page-data|knowledge-maintenance-protocol|controller)\.ts$/u.test(file));
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
    console.log(`PASS browser graph: ${Object.keys(built.metafile.inputs).length} inputs; no Node wrappers; only obsidian external; process/Buffer absent`);
    try { await runEnglishScenarios(module.exports, root); } finally { dom.window.close(); }
  }
} finally { await fs.rm(root, { recursive: true }); }
