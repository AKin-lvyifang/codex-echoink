import { desktopNodeTestBanner } from "./desktop-node-test-host.mjs";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtemp, rm, realpath, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import ts from "typescript";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const vaultsRoot = await realpath(path.join(os.homedir(), "EchoInk-TestVaults", "90-任务临时"));
if (!process.env.ECHOINK_AGENTS_TEST_ROOT?.trim()) throw new Error("Set ECHOINK_AGENTS_TEST_ROOT to an existing task directory under ~/EchoInk-TestVaults/90-任务临时");
const requestedRoot = path.resolve(process.env.ECHOINK_AGENTS_TEST_ROOT);
if (!requestedRoot.startsWith(vaultsRoot + path.sep)) throw new Error("Agent fixtures must stay inside ~/EchoInk-TestVaults/90-任务临时");
const fixtureRoot = await realpath(requestedRoot);
if (!fixtureRoot.startsWith(vaultsRoot + path.sep)) throw new Error("Agent fixture symlink leaves temporary test Vaults");
const runRoot = await mkdtemp(path.join(fixtureRoot, "run-"));
try {
  const output = path.join(runRoot, "agents-storage-tests.mjs");
  // Test these production method bodies without initializing the full Obsidian plugin.
  const mainSource = ts.createSourceFile("main.ts", await readFile(path.join(rootDir, "src/main.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const pluginClass = mainSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "CodexForObsidianPlugin");
  const syncMembers = ["syncPiConversationTaskMetadata", "setPiConversationTaskMetadata", "listPiConversations", "setPiConversationStatus"].map(name => {
    const member = pluginClass.members.find(member => member.name?.getText(mainSource) === name);
    if (!member) throw new Error(`Missing production metadata method: ${name}`);
    return member.getText(mainSource);
  });
  const syncLanes = ["piTaskMetadataSyncTail", "piTaskMetadataWriteTails"].map(name => pluginClass.members.find(member => member.name?.getText(mainSource) === name));
  const legacyCatalogSource = execFileSync("git", ["show", "a1bdd5cb:src/harness/pi-native/file-conversation-catalog.ts"], { cwd: rootDir, encoding: "utf8" });
  await esbuild.build({ banner: desktopNodeTestBanner,
    stdin: { contents: [
      'import { runAgentsStorageTests } from "./src/tests/agents-storage";',
      'import { applyConversationTaskMetadata, patchConversationTaskMetadata, normalizeConversationTaskMetadata } from "./src/agents/task-metadata";',
      'class ProductionMetadataHost {',
      'settings; piLocalData; piRuntimeBundle = null;',
      'constructor(catalog, sessions) { this.piLocalData = { catalog, listConversations: statuses => catalog.list({ statuses }), setConversationStatus: (id, status) => catalog.status(id, status) }; this.settings = { sessions }; }',
      'async ensurePiLocalData() { return this.piLocalData; }',
      'async cancelPiConversationActivation() {}',
      ...syncLanes.filter(Boolean).map(member => member.getText(mainSource)),
      ...syncMembers,
      '}',
      'import { runPiConversationStartupTests } from "./src/tests/pi-native/conversation-startup";',
      'import { runPiConversationTabsTests } from "./src/tests/pi-native/conversation-tabs";',
      'await runAgentsStorageTests(process.env.ECHOINK_AGENTS_FIXTURE_ROOT, (catalog, sessions) => new ProductionMetadataHost(catalog, sessions));',
      'if (process.env.ECHOINK_AGENTS_TEST_CASE !== "hardening") {',
      'await runPiConversationStartupTests();',
      'await runPiConversationTabsTests();',
      'console.log("Existing Conversation startup/tabs regression: PASS");',
      '}'
    ].join("\n"), resolveDir: rootDir, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node22", outfile: output, logLevel: "silent",
    loader: { ".md": "text", ".svg": "text", ".txt": "text" },
    plugins: [{ name: "agents-storage-local-host", setup(build) {
      build.onResolve({ filter: /^legacy-catalog-v1$/ }, () => ({ path: "a1bdd5cb-catalog", namespace: "legacy-catalog" }));
      build.onLoad({ filter: /.*/, namespace: "legacy-catalog" }, () => ({ contents: legacyCatalogSource, loader: "ts", resolveDir: path.join(rootDir, "src/harness/pi-native") }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(rootDir, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => {
        const resolved = import.meta.resolve(args.path);
        return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
      });
    } }]
  });
  const result = spawnSync(process.execPath, [output], {
    cwd: rootDir, stdio: "inherit",
    env: { ...process.env, PI_OFFLINE: "1", TMPDIR: runRoot, ECHOINK_AGENTS_FIXTURE_ROOT: runRoot }
  });
  process.exitCode = result.status ?? 1;
} finally {
  // Only the uniquely created synthetic run directory is removed.
  await rm(runRoot, { recursive: true, force: true });
}
