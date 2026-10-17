import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const allowed = await realpath(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时"));
if (!process.env.ECHOINK_AGENTS_TEST_ROOT) throw new Error("Explicit ECHOINK_AGENTS_TEST_ROOT is required");
const fixture = await realpath(process.env.ECHOINK_AGENTS_TEST_ROOT);
if (!fixture.startsWith(allowed + path.sep)) throw new Error("Fixtures must stay in 90-任务临时");
const runRoot = await mkdtemp(path.join(fixture, "run-agent-runs-"));
try {
  const source = ts.createSourceFile("main.ts", await readFile(path.join(root, "src/main.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "CodexForObsidianPlugin");
  const members = ["piTaskMetadataWriteTails", "piTaskMetadataSyncTail", "conversationRunService", "setPiConversationTaskMetadata", "syncPiConversationTaskMetadata", "getConversationRunService", "consumeAcceptedTaskComposerDraft", "deleteAgent"].map(name => {
    const member = declaration.members.find(member => member.name?.getText(source) === name);
    if (!member) throw new Error(`Missing production member ${name}`);
    return member.getText(source);
  });
  const viewSource = ts.createSourceFile("codex-view.ts", await readFile(path.join(root, "src/ui/codex-view.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const viewClass = viewSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "CodexView");
  const viewMembers = ["onClose", "pendingInteractionsBySession", "settleTaskUiReady"].map(name => viewClass.members.find(member => member.name?.getText(viewSource) === name).getText(viewSource));
  const output = path.join(runRoot, "agent-runs.mjs");
  await esbuild.build({ stdin: { contents: [
    'import { runAgentRunTests } from "./src/tests/agent-runs";',
    'import { ConversationRunService } from "./src/plugin/conversation-run-service";',
    'import { consumeAcceptedTaskDraft } from "./src/agents/task-workspace";',
    'import { removeAgentDefinition } from "./src/agents/registry";',
    'import { GENERAL_ASSISTANT_ID } from "./src/agents/types";',
    'import { applyConversationTaskMetadata, normalizeConversationTaskMetadata, patchConversationTaskMetadata } from "./src/agents/task-metadata";',
    'import { closeComposerParameterMenu } from "./src/ui/codex-view/menus";',
    'import { disposeContextPopover } from "./src/ui/codex-view/composer-controller";',
    'class ProductionHost {',
    'app={}; settings; piRuntimeBundle; piLocalData;',
    'constructor(catalog,runtime,settings){this.settings=settings;this.piRuntimeBundle={runtime};this.piLocalData={catalog};}',
    'async ensurePiLocalData(){return this.piLocalData;}',
    ...members,
    '}',
    'class ProductionViewLifecycle {',
    'constructor(plugin,detach){Object.assign(this,{plugin,runSubscriptionDispose:detach,viewLifecycleGeneration:0,viewLifecycleAbortController:new AbortController(),promptEnhancerRunId:"",taskPlanDock:{dispose(){}},interactionDock:{dispose(){}},messageListRenderer:{dispose(){}},clearHomeAttentionFrame(){},clearKnowledgeBaseRunProgressTimer(){},composerHost(){return {};}});}',
    ...viewMembers,
    '}',
    'await runAgentRunTests(process.env.ECHOINK_AGENT_RUN_FIXTURE_ROOT, (catalog,runtime,settings)=>new ProductionHost(catalog,runtime,settings), (plugin,detach)=>new ProductionViewLifecycle(plugin,detach));'
  ].join("\n"), resolveDir: root, loader: "ts" }, bundle: true, format: "esm", platform: "node", target: "node22", outfile: output, logLevel: "silent", loader: { ".md": "text", ".svg": "text", ".txt": "text" }, plugins: [{ name: "agent-runs-local-host", setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
    build.onResolve({ filter: /^[^./]/ }, args => {
      if (args.path === "electron") return { path: args.path, external: true };
      const resolved = import.meta.resolve(args.path); return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
    });
  } }] });
  const result = spawnSync(process.execPath, [output], { cwd: root, stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1", TMPDIR: runRoot, ECHOINK_AGENT_RUN_FIXTURE_ROOT: runRoot } });
  process.exitCode = result.status ?? 1;
} finally { await rm(runRoot, { recursive: true, force: true }); }
