import { disposableTestRoot } from "./disposable-test-root.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import esbuild from "esbuild";

const project = fileURLToPath(new URL("../", import.meta.url));
const root = disposableTestRoot(path.join(homedir(), "EchoInk-TestVaults/90-任务临时/移动端改版-M11-20261019"));
await fs.mkdir(root, { recursive: true });
const directory = await fs.mkdtemp(path.join(root, "module-shared-"));
const suites = {
  json: `import assert from 'node:assert/strict';
import { normalizeJsonValue as pure } from './src/harness/pi-native/json-value-core';
import { normalizeJsonValue as desktop, canonicalJsonStringify } from './src/harness/pi-native/tool-authorization';
import {runToolAuthorizationAndReceiptTests} from './src/tests/pi-native/tool-authorization-and-receipt';
const cycle = {}; cycle.self = cycle;
const symbol = { [Symbol('hidden')]: 1 }, hidden = {}; Object.defineProperty(hidden, 'hidden', {value: 1});
for (const value of [undefined, NaN, Infinity, 1n, () => {}, new Date(), [, 1], cycle, symbol, hidden]) {
  assert.throws(() => pure(value)); assert.throws(() => desktop(value), error => error.code === 'invalid-input');
}
const source = {z: [-0, null, true], a: {b: 'text'}}, normalized = pure(source);
assert.deepEqual(normalized, {a: {b: 'text'}, z: [0, null, true]});
assert.ok(Object.isFrozen(normalized) && Object.isFrozen(normalized.z) && Object.isFrozen(normalized.a));
source.a.b = 'changed'; assert.equal(normalized.a.b, 'text');
assert.equal(canonicalJsonStringify({b: 2, a: {d: 4, c: 3}}), '{"a":{"c":3,"d":4},"b":2}');
await runToolAuthorizationAndReceiptTests();
console.log('PASS shared JSON strict rejection/freeze/canonical form and original desktop authorization/receipt tests');`,
  finance: `import {runFinanceOperationsServiceTests,runFinanceOperationsToolTests,runFinanceFreshMobileBaselineTest} from './src/tests/finance-operations';
import {runFinanceOperationsPipelineTests} from './src/tests/pi-native/finance-operations-pipeline';
import {runLifestyleFinanceLedgerTests} from './src/tests/lifestyle-finance-ledger';
import {runFinanceBillPlanTests} from './src/tests/finance-bill-plan';
await runFinanceOperationsServiceTests(${JSON.stringify(path.join(directory, "finance"))});
await runFinanceOperationsToolTests(${JSON.stringify(path.join(directory, "tools"))});
await runFinanceFreshMobileBaselineTest();
await runFinanceOperationsPipelineTests(${JSON.stringify(path.join(directory, "pipeline"))});
await runLifestyleFinanceLedgerTests();
await runFinanceBillPlanTests();
console.log('PASS original finance service/tools/pipeline, mobile fresh baseline, ledger and bill plans');`,
  todo: `import {runTodoPageModelTests} from './src/tests/todo-page-model';
import {runTodoProjectTests} from './src/tests/todo-projects';
import {runHomeTodoTests} from './src/tests/home-todos';
await runTodoPageModelTests();
await runTodoProjectTests(${JSON.stringify(path.join(directory, "todo-projects"))});
await runHomeTodoTests();
console.log('PASS original Todo page/source/project/form/completion-history tests');`
};
try {
  const selected = process.argv.slice(2);
  if (selected.some(name => !Object.hasOwn(suites, name))) throw new Error('Use suite names: json finance todo');
  for (const name of selected.length ? selected : Object.keys(suites)) {
  const target = path.join(directory, `${name}.mjs`);
  console.log(`RUN shared ${name} original regression; fixtures: ${directory}`);
  await esbuild.build({ stdin: { contents: suites[name], resolveDir: project, loader: "ts" },
    outfile: target, bundle: true, platform: "node", format: "esm", logLevel: "silent", loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl", ".txt": "text" },
    banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(path.join(project, "package.json"))});` },
    plugins: [{ name: "module-shared-packages", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(project, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(project, "src/tests/origin-controls-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => { const url = import.meta.resolve(args.path); return { path: url.startsWith("node:") ? url : fileURLToPath(url), external: true }; });
    } }] });
  const result = spawnSync(process.execPath, [fileURLToPath(pathToFileURL(target))], { stdio: "inherit", env: { ...process.env, TMPDIR: directory, ECHOINK_TODO_UI_FIXTURE: directory } });
  if (result.status !== 0) { process.exitCode = result.status ?? 1; if (result.error) console.error(result.error); }
  console.log(`EXIT shared ${name}: ${result.status ?? 1}`);
  }
} finally { await fs.rm(directory, { recursive: true }); }
