import assert from "node:assert/strict";
import { readFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { expand } from "brace-expansion";
import { piBraceExpansionPlugin } from "./pi-brace-expansion.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const directory = path.join(root, ".tmp/pi-brace-expansion-tests");
const fixedVersion = require("brace-expansion/package.json").version;
assert.equal(fixedVersion, "5.0.9");
const legacyMinimatch = require(path.join(root, "node_modules/@earendil-works/pi-coding-agent/node_modules/minimatch/dist/commonjs/index.js"));
const patterns = ["{a,b}.md", "note-{01..03}.md", "{c..a}", "{a,{b,c}}", "{,x}", "a\\{b,c\\}", "普通笔记.md", "${name}"];
await mkdir(directory, { recursive: true });
try {
  if (!process.argv.includes("--production")) {
    for (const format of ["esm", "commonjs"]) {
      const source = `node_modules/@earendil-works/pi-coding-agent/node_modules/minimatch/dist/${format}/index.js`;
      const out = path.join(directory, `${format}.cjs`);
      const built = await esbuild.build({
        entryPoints: [source], absWorkingDir: root, bundle: true, platform: "node", format: "cjs",
        outfile: out, metafile: true, plugins: [piBraceExpansionPlugin], logLevel: "silent"
      });
      const minimatch = require(out);
      const dependency = built.metafile.inputs[source].imports.find(item => item.original === "brace-expansion");
      assert.ok(dependency?.path.startsWith("node_modules/brace-expansion/"), format);
      assert.equal(Object.keys(built.metafile.inputs).some(name => name.includes("pi-coding-agent/node_modules/brace-expansion/")), false);
      for (const pattern of patterns) assert.deepEqual(minimatch.braceExpand(pattern), legacyMinimatch.braceExpand(pattern), pattern);
      assert.equal(minimatch.minimatch("note-02.md", "note-{01..03}.md"), true);
      assert.equal(minimatch.minimatch("note-04.md", "note-{01..03}.md"), false);
      console.log(`Pi minimatch ${format} -> brace-expansion ${fixedVersion}; normal patterns compatible: PASS`);
    }

    // Verify unrelated consumers keep their own API; no global alias is applied.
    const other = await esbuild.build({
      entryPoints: ["node_modules/minimatch/minimatch.js"], absWorkingDir: root,
      bundle: true, platform: "node", write: false, metafile: true,
      plugins: [piBraceExpansionPlugin], logLevel: "silent"
    });
    assert.ok(Object.keys(other.metafile.inputs).some(name => name.includes("minimatch/node_modules/brace-expansion/index.js")));

    // Bounded fixtures for both advisories: chained groups, cumulative comma
    // alternatives, and padded sequences. Never run the upstream OOM payloads.
    const alternatives = `{${Array(8).fill(`{${"0".repeat(30)}1..200}`).join(",")}}`;
    for (const input of ["{a,b}".repeat(25), alternatives, `{${"0".repeat(30)}1..200}`]) {
      const results = expand(input, { max: 20, maxLength: 128 });
      assert.ok(results.length > 0 && results.length <= 20);
      assert.ok(results.reduce((total, item) => total + item.length, 0) <= 128);
    }
    console.log("GHSA-mh99-v99m-4gvg and GHSA-rgw5-rvv9-x895 bounded expansion fixtures: PASS");
  }

  if (process.argv.includes("--production")) {
    const meta = JSON.parse(await readFile(path.join(root, ".tmp/production-metafile.json"), "utf8"));
    const edges = Object.entries(meta.inputs).filter(([name]) => /pi-coding-agent\/node_modules\/minimatch\/dist\/(esm|commonjs)\/index\.js$/.test(name));
    assert.ok(edges.length > 0, "production must contain Pi minimatch");
    for (const [name, input] of edges) {
      const edge = input.imports.find(item => item.original === "brace-expansion");
      assert.ok(edge?.path.startsWith("node_modules/brace-expansion/"), name);
    }
    const output = meta.outputs["dist/main.js"];
    assert.ok(output);
    const braceInputs = Object.entries(output.inputs).filter(([name, data]) => /\/brace-expansion\/(?:dist\/|index\.js)/.test(name) && data.bytesInOutput > 0);
    assert.ok(braceInputs.length > 0);
    for (const [name, data] of braceInputs) {
      assert.ok(name.startsWith("node_modules/brace-expansion/"), `unexpected production implementation: ${name}`);
      console.log(`Production implementation: ${name} (${fixedVersion}, ${data.bytesInOutput} bytes)`);
    }
    assert.equal(Object.keys(meta.inputs).some(name => name.includes("pi-coding-agent/node_modules/brace-expansion/")), false);
    console.log("Production graph: fixed root implementation only; upstream 5.0.7 absent: PASS");
  }
} finally { await rm(directory, { recursive: true, force: true }); }
