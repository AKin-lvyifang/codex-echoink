import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Module, { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import * as zlib from "node:zlib";
import esbuild from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compressPinyinDictionary, pinyinDictionaryCompressionPlugin, radixIconsEsmPlugin } from "./bundle-static-data.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const names = ["dict1", "dict2", "dict3", "dict4", "dict5", "surname"];
let dictionaryKeys = 0;
for (const name of names) {
  const source = await readFile(require.resolve(`pinyin-pro/dist/esm/data/${name}.mjs`), "utf8");
  const { data, compressed } = compressPinyinDictionary(source, `${name}.mjs`);
  const restored = JSON.parse(zlib.brotliDecompressSync(compressed).toString("utf8"));
  assert.deepEqual(restored, data, `${name}: all literal entries must roundtrip`);
  dictionaryKeys += Object.keys(data).length;
}
for (const initializer of ["fetch('external')", "{ get a() { return 'x' } }", "{ ['computed']: 'x' }", "{ a: ['ok', fetch('external')] }"]) {
  assert.throws(() => compressPinyinDictionary(`const DICT2 = ${initializer};`, "dict2.mjs"));
}

const directory = await mkdtemp(path.join(tmpdir(), "echoink-static-data-"));
const originalLoad = Module._load;
let decompressCalls = 0;
let decompressMs = 0;
try {
  const entry = [
    'export { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "@radix-ui/react-icons";',
    'export * from "pinyin-pro";',
    ...names.map((name) => `export { default as ${name} } from "pinyin-pro/dist/esm/data/${name}.mjs";`),
    'export { buildNoteMentionCatalog, searchNoteMentionCatalog } from "./src/ui/codex-view/note-mentions";',
    'export const unicodeFixture = "中文🙂𠮷\\u2028\\u2029";'
  ].join("\n");
  for (const optimized of [false, true]) {
    await esbuild.build({
      stdin: { contents: entry, resolveDir: root, loader: "ts" },
      bundle: true, format: "cjs", platform: "node", target: "es2022", minify: true,
      charset: optimized ? "utf8" : "ascii", external: ["react"],
      plugins: [
        ...(optimized ? [radixIconsEsmPlugin, pinyinDictionaryCompressionPlugin] : []),
        { name: "obsidian-test-api", setup(build) {
          build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
        } }
      ],
      outfile: path.join(directory, `${optimized ? "optimized" : "original"}.cjs`), logLevel: "silent"
    });
  }
  Module._load = function(request, parent, isMain) {
    if (request === "react") return React;
    if (request === "node:zlib") return { ...zlib, brotliDecompressSync(...args) {
      const started = performance.now();
      const result = zlib.brotliDecompressSync(...args);
      decompressMs += performance.now() - started;
      decompressCalls++;
      return result;
    } };
    return originalLoad.call(this, request, parent, isMain);
  };
  const originalStart = performance.now();
  const original = require(path.join(directory, "original.cjs"));
  const originalMs = performance.now() - originalStart;
  const optimizedStart = performance.now();
  const optimized = require(path.join(directory, "optimized.cjs"));
  const optimizedMs = performance.now() - optimizedStart;
  assert.equal(decompressCalls, 6);

  // Compare actual upstream exported lookup data after module initialization,
  // independently of the build-time literal reader and JSON roundtrip check.
  assert.deepEqual(optimized.dict1.NumberDICT, original.dict1.NumberDICT);
  assert.deepEqual(optimized.dict1.StringDICT, original.dict1.StringDICT);
  for (const name of names.slice(1)) assert.deepEqual(optimized[name], original[name]);
  assert.equal(optimized.unicodeFixture, original.unicodeFixture);

  for (const icon of ["CheckIcon", "ChevronDownIcon", "ChevronUpIcon"]) {
    for (const props of [{}, { width: 16, height: 16, className: "select-icon", "aria-hidden": true },
      { color: "#123456", width: 23, height: 19, "aria-label": "选中", style: { opacity: 0.6 } }]) {
      assert.equal(renderToStaticMarkup(React.createElement(optimized[icon], props)),
        renderToStaticMarkup(React.createElement(original[icon], props)), `${icon} SVG must remain identical`);
    }
  }
  for (const text of ["项目复盘", "重庆银行", "音乐长大", "单田芳", "万俟", "行行重行行", "𠮷野家🙂abc", "龘靐齉爩"]) {
    for (const options of [{}, { toneType: "none" }, { pattern: "first", toneType: "none" }, { type: "array", multiple: true }]) {
      assert.deepEqual(optimized.pinyin(text, options), original.pinyin(text, options));
    }
    assert.deepEqual(optimized.polyphonic(text), original.polyphonic(text));
  }
  const inputs = [
    { vaultRelativePath: "projects/项目复盘.md", fileName: "项目复盘.md", aliases: ["周会总结"] },
    { vaultRelativePath: "travel/重庆银行.md", fileName: "重庆银行.md", aliases: ["山城"] },
    { vaultRelativePath: "music/音乐.md", fileName: "音乐.md" }
  ];
  const before = original.buildNoteMentionCatalog(inputs);
  const after = optimized.buildNoteMentionCatalog(inputs);
  assert.deepEqual(after, before);
  for (const query of ["xiangmufupan", "xmfp", "chongqingyinhang", "cqyh", "yinyue", "yy", "shancheng", "sc"]) {
    const expected = original.searchNoteMentionCatalog(before, query);
    assert.ok(expected.length > 0, `reference search must match: ${query}`);
    assert.deepEqual(optimized.searchNoteMentionCatalog(after, query), expected);
  }
  assert.equal(decompressCalls, 6, "public calls must reuse initialized dictionaries");
  console.log(`Static bundle data: PASS (9 SVG renders, 6 full dictionaries/${dictionaryKeys} keys, UTF-8, pinyin/polyphonic/search)`);
  console.log(`Isolated module load: original=${originalMs.toFixed(2)}ms, optimized=${optimizedMs.toFixed(2)}ms, `
    + `6 dictionary decompress calls=${decompressMs.toFixed(2)}ms (${process.platform}/${process.arch}, ${process.version})`);
} finally {
  Module._load = originalLoad;
  await rm(directory, { recursive: true, force: true });
}
