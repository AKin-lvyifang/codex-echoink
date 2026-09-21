import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import esbuild from "esbuild";
import {
  poolDesktopStrings, desktopBundleMarkers, assertDesktopMarkersPreserved
} from "./desktop-string-pool.mjs";
import { findDynamicScriptCreations } from "./react-dom-script-resources.mjs";

const require = createRequire(import.meta.url);
let checks = 0;
function run(source, extra = {}) {
  const context = { module: { exports: {} }, Buffer, require, ...extra };
  vm.runInNewContext(source, context);
  return context.module.exports;
}
async function test(name, check) { await check(); checks++; console.log(`OK ${name}`); }

await test("strings restore exact UTF-16 values, including escapes and lone surrogates", () => {
  const strings = [
    "中文与 emoji 🖋️，仍保留所有空格。",
    'A long string with "quotes", \\ slash,\nnewlines and\0 NUL',
    "lone high surrogate \ud800, lone low \udfff and complete 🪶",
    "a deliberately repeated static message", "a deliberately repeated static message"
  ];
  const source = `module.exports=${JSON.stringify(strings)};`;
  const pooled = poolDesktopStrings(source);
  assert.equal(pooled.count, 5); assert.equal(pooled.unique, 4);
  assert.deepEqual([...run(pooled.code)], strings);
});

await test("directives, keys, module paths, tagged templates and dynamic code stay literal", () => {
  const source = String.raw`"use strict";
const object = {"a-long-property-name": "ordinary pooled field value", ["a-computed-property-name"]: true};
const moduleName = "./relative-module-name.mjs";
const packageName = "a-very-long-package-name";
const dependency = require(packageName);
const tag = (parts) => parts.raw[0];
const raw = tag\`a long raw template with \\u{1F642}\`;
const code = "return 'standalone generated code text';";
module.exports = [object["a-long-property-name"], moduleName, dependency, raw, new Function(code)(), eval("'standalone eval text'")];`.replaceAll("\\`", "`");
  const pooled = poolDesktopStrings(source);
  for (const literal of ['"use strict"', '"a-long-property-name"', '"a-computed-property-name"', '"./relative-module-name.mjs"', '"a-very-long-package-name"', '"return \'standalone generated code text\';"']) {
    assert.ok(pooled.code.includes(literal), literal);
  }
  const dependencies = id => id === "a-very-long-package-name" ? "fake dependency" : require(id);
  assert.deepEqual([...run(pooled.code, { require: dependencies })], [...run(source, { require: dependencies })]);
  assert.ok(pooled.code.startsWith('"use strict";'));
});

await test("serialized functions, aliases, callback parameters and classes remain self-contained", async () => {
  const source = `
function worker() { return "literal inside a serialized worker"; }
const alias = worker;
function serialize(callback) { return callback.toString(); }
const arrow = () => "literal inside a serialized arrow";
class WorkerClass { message() { return "literal inside a serialized class"; } }
const inline = (function () { return "literal inside an inline function"; })["toString"]();
module.exports = [serialize(alias), Function.prototype.toString.call(arrow), String(WorkerClass), inline,
  "ordinary string that should be pooled"];
`;
  const pooled = poolDesktopStrings(source);
  assert.equal(pooled.count, 1);
  const original = run(source), restored = run(pooled.code);
  for (let index = 0; index < 4; index++) assert.equal(restored[index], original[index]);
  // The final production minifier may rename local symbols, but serialized
  // functions must still run outside the pool's lexical scope.
  const minified = await esbuild.transform(pooled.code, { minify: true, target: "es2022", charset: "utf8" });
  const serialized = run(minified.code);
  assert.equal(vm.runInNewContext(`(${serialized[0]})()`), "literal inside a serialized worker");
  assert.equal(vm.runInNewContext(`(${serialized[1]})()`), "literal inside a serialized arrow");
  assert.equal(vm.runInNewContext(`new (${serialized[2]})().message()`), "literal inside a serialized class");
  assert.equal(vm.runInNewContext(`(${serialized[3]})()`), "literal inside an inline function");
});

await test("all actual bundle markers and forbidden script creation remain detectable", () => {
  const markers = desktopBundleMarkers();
  assert.ok(markers.includes("Downloading... ripgrep"));
  assert.ok(markers.includes("OpenAI Codex OAuth"));
  const source = `module.exports=${JSON.stringify(markers.map(marker => `prefix ${marker} suffix`))};\ndocument.createElement("script");`;
  const pooled = poolDesktopStrings(source, markers);
  assertDesktopMarkersPreserved(source, pooled.code, markers);
  assert.equal(findDynamicScriptCreations(source).length, 1);
  assert.equal(findDynamicScriptCreations(pooled.code).length, 1);
  for (const marker of markers) assert.throws(() => assertDesktopMarkersPreserved(marker, "", markers), /marker visibility/u);
});

await test("initializer collision and switch/return token boundaries retain behavior", () => {
  const source = `var __echoinkStrings = "existing binding stays usable";
function f(value) { switch(value) { case "a long switch branch": return "a long branch result"; default: return __echoinkStrings; } }
module.exports = [f("a long switch branch"), f("other")];`;
  const pooled = poolDesktopStrings(source);
  assert.deepEqual([...run(pooled.code)], [...run(source)]);
});

await test("desktop pool is dormant on mobile and decodes once per desktop activation", async () => {
  const pooled = poolDesktopStrings('module.exports="a long desktop-only string";').code;
  const source = `function loadDesktop(){var module={exports:{}};${pooled}\nreturn module.exports;}
module.exports = mobile ? "mobile result" : loadDesktop();`;
  const minified = (await esbuild.transform(source, { minify: true, target: "es2022", charset: "utf8" })).code;
  assert.equal(run(minified, { mobile: true, Buffer: undefined, require() { throw new Error("Node on mobile"); } }), "mobile result");
  let decodes = 0;
  const zlib = require("node:zlib");
  const result = run(minified, { mobile: false, require(id) {
    assert.equal(id, "node:zlib");
    return { brotliDecompressSync(bytes) { decodes++; return zlib.brotliDecompressSync(bytes); } };
  } });
  assert.equal(result, "a long desktop-only string"); assert.equal(decodes, 1);
});

await test("invalid JavaScript fails before a bundle is written", () => {
  assert.throws(() => poolDesktopStrings('const broken = "unfinished'), /Cannot parse/u);
});

console.log(`${checks} desktop string-pool checks passed.`);
