import esbuild from "esbuild";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { disposableTestRoot } from "./disposable-test-root.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
if (!process.env.ECHOINK_TEST_ROOT?.trim()) throw new Error("Set ECHOINK_TEST_ROOT to this task's explicit disposable fixture directory.");
const configured = disposableTestRoot(process.env.ECHOINK_TEST_ROOT);
const output = path.join(configured, "r-da4ae1", `run-${Date.now()}`);
await mkdir(path.join(output, "tmp"), { recursive: true });
const legacyPath = path.join(root, "src/plugin/pi-knowledge-maintenance-production.ts");
async function run(name, contents, legacySource) {
  const outfile = path.join(output, `${name}.mjs`);
  await esbuild.build({ stdin: { contents, resolveDir: root, loader: "ts" }, bundle: true, platform: "node", target: "node22", format: "esm", outfile,
    loader: { ".md": "text", ".txt": "text", ".svg": "dataurl", ".webp": "dataurl" },
    banner: { js: `import { createRequire as createFixtureRequire } from "node:module"; const require=createFixtureRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    plugins: [{ name: "r-da4ae1-host", setup(build) {
      if (legacySource) {
        build.onResolve({ filter: /^legacy-maintenance-production$/ }, () => ({ path: legacyPath, namespace: "legacy-maintenance" }));
        build.onLoad({ filter: /.*/, namespace: "legacy-maintenance" }, () => ({ contents: legacySource, resolveDir: path.dirname(legacyPath), loader: "ts" }));
      }
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /provider-brand-icons$/ }, () => ({ path: path.join(root, "src/tests/composer-provider-brand-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path === "electron") return { path: args.path, external: true };
        const resolved = import.meta.resolve(args.path);
        return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
      });
    } }] });
  const result = spawnSync(process.execPath, [outfile], { cwd: root, stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1", TMPDIR: path.join(output, "tmp"), ECHOINK_KNOWLEDGE_TEST_ROOT: output } });
  assert.equal(result.status, 0, `${name} failed; fixtures: ${output}`);
}

await run("a-b", `import { runRDa4ae1MaintenanceTests } from "./src/tests/r-da4ae1-maintenance";
import { runRDa4ae1MaintenanceRuntimeTests } from "./src/tests/pi-native/pi-native-conversation-runtime";
await runRDa4ae1MaintenanceTests(${JSON.stringify(path.join(output, "a"))}); await runRDa4ae1MaintenanceRuntimeTests();`);
const privateRoot = path.join(output, "a/old-20/.obsidian/plugins/echoink/knowledge");
// Requires these local historical refs; this test never fetches repository history.
for (const baseline of ["2.8.8", "4641cc6e"]) {
  const source = execFileSync("git", ["show", `${baseline}:src/plugin/pi-knowledge-maintenance-production.ts`], { cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  await run(`legacy-${baseline}`, `import assert from "node:assert/strict";
import { readPrivateMaintenanceRecords, FilePhase3MaintenanceStateStore } from "legacy-maintenance-production";
import { readPrivateMaintenanceRecords as readCurrent } from "./src/plugin/pi-knowledge-maintenance-production";
import { hasP1PartialSettlement } from "./src/knowledge-base/maintenance-record";
const root=${JSON.stringify(privateRoot)};
const [record]=await readPrivateMaintenanceRecords(root); assert.ok(record?.p1?.settlement); assert.equal(record.p1.phase,"finalize");
const expected=JSON.parse(JSON.stringify(record.p1));
await new FilePhase3MaintenanceStateStore({storageRootPath:root,vaultId:"r-da4ae1"}).saveP1Record(record);
const [saved]=await readPrivateMaintenanceRecords(root); assert.deepEqual(saved.p1,expected);
const [current]=await readCurrent(root); assert.equal(hasP1PartialSettlement(current),true);
console.log(${JSON.stringify(`Legacy ${baseline} maintenance read/write roundtrip: PASS (optional fields preserved; phase remains finalize)`)});`, source);
}
console.log(`R-DA4AE1 fixtures: ${output}`);
