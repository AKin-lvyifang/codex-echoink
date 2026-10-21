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
import { runPageScenarios } from "../tests/mobile-knowledge-page-services/scenarios.mjs";

let project = fileURLToPath(new URL("../", import.meta.url));
const harness = path.join(project, "tests/mobile-knowledge-page-services/dom.mjs");
const registered = path.join(homedir(), "EchoInk-TestVaults/90-任务临时/移动端改版-M13-20261019");
await fs.mkdir(registered, { recursive: true });
const root = await fs.mkdtemp(path.join(registered, "knowledge-page-"));
try {
  if (process.argv.includes("--baseline")) {
    const baseline = path.join(root, "baseline-a53a5a97"); await fs.mkdir(baseline);
    const archive = spawnSync("git", ["archive", "a53a5a97"], { cwd: project, maxBuffer: 128 * 1024 * 1024 });
    if (archive.status !== 0) throw Error("Could not archive immutable M12 baseline");
    const unpack = spawnSync("tar", ["-x", "-C", baseline], { input: archive.stdout });
    if (unpack.status !== 0) throw Error("Could not unpack immutable M12 baseline");
    await fs.symlink(path.join(project, "node_modules"), path.join(baseline, "node_modules"), "dir"); project = baseline;
    console.log("Immutable original test sources: a53a5a97; existing dependencies; all fixtures under registered M13 root");
  }
  if (process.argv.includes("--lint")) {
    const files = ["src/home/knowledge-page-data.ts", "src/knowledge-base/dashboard.ts", "src/knowledge-base/knowledge-maintenance-protocol.ts", "src/knowledge-base/raw-digest.ts", "src/knowledge-base/source-health.ts", "src/knowledge-base/digest-status.ts", "src/settings/knowledge-maintenance-history.ts"];
    const result = spawnSync(path.join(project, "node_modules/.bin/eslint"), ["-f", "json", ...files], { cwd: project, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    const data = JSON.parse(result.stdout); for (const entry of data) { delete entry.source; entry.filePath = path.relative(project, entry.filePath); }
    console.log(JSON.stringify(data, null, 2)); process.exitCode = result.status ?? 1;
  } else if (process.argv.includes("--desktop")) {
    const suites = {
      page: ["knowledge-page-data", "runKnowledgePageDataTests", "root"],
      history: ["knowledge-maintenance-history", "runKnowledgeMaintenanceHistoryTests", ""],
      maintenance: ["pi-native/phase3-maintenance-service", "runPhase3KnowledgeMaintenanceServiceTests", ""],
      sources: ["knowledge-link-source-characterization", "runKnowledgeLinkSourceCharacterizationTests", ""],
      health: ["home-workspace-data", "runHomeWorkspaceDataTests", ""]
    };
    const requested = process.argv.find(arg => arg.startsWith("--suite="))?.slice(8);
    for (const [id, [file, fn, argument]] of Object.entries(suites)) {
      if (requested && requested !== id) continue;
      const target = path.join(root, `${id}.mjs`), suiteRoot = path.join(root, id); await fs.mkdir(suiteRoot);
      await esbuild.build({ stdin: { contents: `export {${fn}} from './src/tests/${file}';`, resolveDir: project, loader: "ts" }, outfile: target,
        bundle: true, platform: "node", target: "node22", format: "esm", logLevel: "silent", loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl", ".txt": "text" },
        banner: { js: `import {createRequire as createM13Require} from 'node:module';const require=createM13Require(${JSON.stringify(path.join(project, "package.json"))});` },
        plugins: [{ name: "original-m13-desktop-regressions", setup(build) {
          build.onResolve({ filter: /^electron$/ }, args => ({ path: args.path, external: true }));
          build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(project, "src/tests/obsidian-shim.ts") }));
          if (id !== "history") build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(project, "src/tests/origin-controls-shim.ts") }));
          build.onResolve({ filter: /^[^./]/ }, args => { const url = import.meta.resolve(args.path); return { path: url.startsWith("node:") ? url : fileURLToPath(url), external: true }; });
        } }] });
      const bootstrap = path.join(root, `${id}-run.mjs`);
      await fs.writeFile(bootstrap, `import {close} from ${JSON.stringify(harness)};const root=${JSON.stringify(suiteRoot)};try{await (await import(${JSON.stringify(target)})).${fn}(${argument});console.log('PASS original ${id}');}finally{close();}`);
      const run = spawnSync(process.execPath, [bootstrap], { stdio: "inherit", env: { ...process.env, TZ: "America/Los_Angeles", TMPDIR: root, ECHOINK_MODULES_TEST_ROOT: root, PI_OFFLINE: "1" } });
      if (run.status !== 0) { console.log(`FAIL original ${id}: exit=${run.status}`); process.exitCode = 1; }
    }
  } else {
    process.env.TZ = "America/Los_Angeles";
    const built = await esbuild.build({ ...mobileBuildOptions("tests/mobile-knowledge-page-services/entry.ts"), metafile: true });
    const blocked = Object.keys(built.metafile.inputs).filter(file => /node:|(?:^|\/)(?:root-paths|raw-digest|dashboard|source-health|knowledge-page-data|knowledge-maintenance-protocol)\.ts$/u.test(file));
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
    try { await runPageScenarios(module.exports, root); } finally { dom.window.close(); }
  }
} finally { await fs.rm(root, { recursive: true }); }
