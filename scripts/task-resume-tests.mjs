import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import ts from "typescript";
const root = fileURLToPath(new URL("../", import.meta.url));
const allowed = await realpath(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时"));
if (!process.env.ECHOINK_TASK_RESUME_TEST_ROOT) throw new Error("Explicit ECHOINK_TASK_RESUME_TEST_ROOT is required");
const parent = await realpath(process.env.ECHOINK_TASK_RESUME_TEST_ROOT);
if (!parent.startsWith(allowed + path.sep)) throw new Error("Task resume fixtures must stay in 90-任务临时");
const fixture = await mkdtemp(path.join(parent, "p4-runtime-tests-"));
const stageOnly = process.argv.includes("--stage-only");
const restartOnly = process.argv.includes("--restart-only");
try {
  const source = ts.createSourceFile("main.ts", await readFile(path.join(root, "src/main.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "CodexForObsidianPlugin");
  const names = ["conversationRunService", "piTaskMetadataWriteTails", "piTaskMetadataSyncTail", "getConversationRunService", "consumeAcceptedTaskComposerDraft", "setPiConversationTaskMetadata", "resumeTask", "isTaskResuming", "getTaskResumeError", "activeTaskResumeSafety", "resumeTaskAndOpenDetail", "readTaskInterruption", "recordTaskInterruption", "prepareTaskResume", "deleteAgent", "agentRegistryWriteTail", "agentRegistryListeners", "writeAgentRegistry"];
  const members = names.map(name => {
    const member = declaration.members.find(member => member.name?.getText(source) === name);
    if (!member) throw new Error(`Missing production member ${name}`);
    return member.getText(source);
  });
  const startup = declaration.members.find(member => member.name?.getText(source) === "ensurePiLocalData").getText(source);
  const runtimeSource = ts.createSourceFile("runtime.ts", await readFile(path.join(root, "src/harness/pi-native/pi-native-conversation-runtime.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const runtimeClass = runtimeSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "PiNativeConversationRuntime");
  const stageFunction = runtimeSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "taskInterruptionStage").getText(runtimeSource);
  const recordInterruption = runtimeClass.members.find(member => member.name?.getText(runtimeSource) === "recordTaskInterruption").getText(runtimeSource);
  const stageContents = [
    'import {runTaskResumeStageTests,runTaskResumeDurableStageTests} from "./src/tests/task-resume";',
    'import {latestTaskPlanFromBranch} from "./src/types/task-plan";',
    'import {latestTaskRun} from "./src/agents/task-resume";',
    'import {readTaskResumeSafety} from "./src/plugin/task-resume-safety";',
    'import {readDurableTaskInterruptionStage} from "./src/harness/pi-native/pi-native-conversation-runtime";',
    stageFunction,
    'class StageHost { constructor(active){this.active=new Map([["task",active]]); this.saved=null; this.productRuns={read:async()=>({productRunId:"current",state:"running",updatedAt:1}),update:async(id,patch)=>{this.saved=patch.interruption;}};} now(){return 100;} checkpointConversationLeaf(){}',
    recordInterruption,
    '}',
    'await runTaskResumeStageTests(async active=>{const host=new StageHost(active);await host.recordTaskInterruption("task","app_closed");return host.saved;});',
    'class DurableStageHost { constructor(local,root){this.local=local;this.root=root;} async ensurePiLocalData(){return this.local;} getVaultPath(){return this.root;}',
    declaration.members.find(member=>member.name?.getText(source)==="readTaskInterruption").getText(source),
    '}',
    'await runTaskResumeDurableStageTests(process.env.ECHOINK_P4_RUNTIME_TEST_ROOT,async(local,root)=>await new DurableStageHost(local,root).readTaskInterruption("task"));'
  ].join("\n");
  const restartContents = 'import {runTaskResumeRestartTests} from "./src/tests/task-resume-restart"; await runTaskResumeRestartTests(process.env.ECHOINK_P4_RUNTIME_TEST_ROOT,process.env.ECHOINK_P4_RESTART_PHASE);';
  await esbuild.build({ stdin: { contents: restartOnly ? restartContents : stageOnly ? stageContents : [
    'import {runTaskResumeTests} from "./src/tests/task-resume";',
    'import {ConversationRunService} from "./src/plugin/conversation-run-service";',
    'import {latestTaskRun} from "./src/agents/task-resume";',
    'import {readDurableTaskInterruptionStage} from "./src/harness/pi-native/pi-native-conversation-runtime";',
    'import {prepareTaskResumeSafety,readTaskResumeSafety} from "./src/plugin/task-resume-safety";',
    'import {assertTaskResumeCapabilities} from "./src/plugin/pi-production-runtime-composition";',
    'import {cloneQueuedTurnItem} from "./src/ui/turn-queue";',
    'import {frozenTurnReasoningSelectionIsValid} from "./src/ui/codex-view/turn-runner";',
    'import {resolveComposerReasoningState} from "./src/ui/composer-reasoning";',
    'import {assertPiSubmissionActive} from "./src/harness/pi-native/pi-submission-lifecycle";',
    'import {getActiveApiProviderModel,getApiProviderModel,apiProviderHasUsableCredential,validateApiProvider,newId} from "./src/settings/settings";',
    'import {GENERAL_ASSISTANT_ID} from "./src/agents/types";',
    'import {removeAgentDefinition} from "./src/agents/registry";',
    'import {applyConversationTaskMetadata,patchConversationTaskMetadata} from "./src/agents/task-metadata";',
    'import {consumeAcceptedTaskDraft} from "./src/agents/task-workspace";',
    'class ProductionHost {',
    'constructor(local,settings,runtime,root){Object.assign(this,{piLocalData:local,settings,piRuntimeBundle:{runtime},app:{vault:{getAbstractFileByPath(){return null;}},internalPlugins:{getPluginById(){return null;}}},root});}',
    'async ensurePiLocalData(){return this.piLocalData;} getVaultPath(){return this.root;} async saveSettings(){} async buildRuntimeEchoInkResourceCatalog(){return [];} async externalizeMessageText(){} async abortPiConversation(id){await this.piRuntimeBundle.runtime.abort(id);} async readPiConversationProjection(id){return await this.piRuntimeBundle.runtime.readProjection(id);} async openTaskDetail(id){this.opened=id;}',
    'getCodexView(){return null;}',
    ...members,
    '}',
    'const PiLocalDataService={create:async host=>host.startupLocal};',
    'class StartupHost { piLocalData; piLocalDataFlight; patches=[]; constructor(local){this.startupLocal=local;} async setPiConversationTaskMetadata(id,patch){this.patches.push({id,patch});}',
    startup,
    '}',
    'await runTaskResumeTests(process.env.ECHOINK_P4_RUNTIME_TEST_ROOT,(...args)=>new ProductionHost(...args),local=>new StartupHost(local));'
  ].join("\n"), resolveDir: root, loader: "ts" }, outfile: path.join(fixture, "test.mjs"), bundle: true, format: "esm", platform: "node", target: "node22", logLevel: "silent", loader: { ".md": "text", ".svg": "text", ".txt": "text" }, plugins: [{ name: "p4-runtime-host", setup(build) {
    build.onResolve({ filter: /turn-runner$/ }, args => args.importer.endsWith("conversation-run-service.ts") ? { path: "test-runner", namespace: "p4-test" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "p4-test" }, () => ({ contents: 'export async function startQueuedTurnItemSafely(context,item,source){return await context.plugin.acceptTestTurn(context,item,source);} export const startQueuedTurnItem=startQueuedTurnItemSafely; export const startChatTurn=startQueuedTurnItemSafely;', loader: "ts" }));
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
    build.onResolve({ filter: /^[^./]/ }, args => {
      if (args.path === "electron") return { path: args.path, external: true };
      const resolved = import.meta.resolve(args.path); return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
    });
  } }] });
  for (const phase of restartOnly ? ["produce", "consume"] : [""]) {
    const result = spawnSync(process.execPath, [path.join(fixture, "test.mjs")], { cwd: root, stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1", TMPDIR: fixture, ECHOINK_P4_RUNTIME_TEST_ROOT: fixture, ECHOINK_P4_RESTART_PHASE: phase } });
    process.exitCode = result.status ?? 1;
    if (process.exitCode) break;
  }
} finally { await rm(fixture, { recursive: true, force: true }); }
