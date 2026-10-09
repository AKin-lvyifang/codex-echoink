import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const outputDir = path.join(rootDir, ".tmp");
const outputFile = path.join(outputDir, "provider-settings-tests.mjs");
const obsidianShimPath = path.join(
  rootDir,
  "src",
  "tests",
  "obsidian-shim.ts"
);

await mkdir(outputDir, { recursive: true });
if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "theme-isolation") {
  const ts = await import("typescript");
  const { execFileSync } = await import("node:child_process");
  const ast = ts.createSourceFile("provider-model-modal.ts", await readFile(path.join(rootDir, "src/settings/provider-model-modal.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ProviderModelModal");
  const methods = ["createField", "renderProviderNameField", "renderApiKeyField"].map(name => {
    const method = declaration.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === name);
    if (!method) throw new Error(`Production provider field missing: ${name}`);
    return method.getText(ast);
  }).join("\n");
  const avatarAst=ts.createSourceFile("agent-identity-modal.ts",await readFile(path.join(rootDir,"src/ui/agent-identity-modal.ts"),"utf8"),ts.ScriptTarget.Latest,true);
  const avatarClass=avatarAst.statements.find(node=>ts.isClassDeclaration(node)&&node.name?.text==="AgentIdentityModal");
  const avatarMethod=avatarClass.members.find(node=>ts.isMethodDeclaration(node)&&node.name.getText(avatarAst)==="renderAvatarOption").getText(avatarAst);
  const avatarEquals=avatarAst.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==="avatarEquals").getText(avatarAst);
  const directory = path.join(outputDir, "theme-isolation");
  await mkdir(directory, { recursive: true });
  await esbuild.build({
    stdin: { contents: `
      import {runThemeIsolation,runThemeIsolationExtras} from "./src/tests/theme-isolation-dom";
      import {createOriginInput,createOriginButton} from "./src/settings/origin-controls";
      import {apiProviderConfiguredNameOverride,apiProviderPresetDisplayName} from "./src/settings/provider-presets";
      import {setIcon} from "obsidian";
      import {AGENT_AVATAR_PRESETS} from "./src/ui/agent-avatar-presets";
      ${avatarEquals}
      class AvatarFields {
        avatarValue={kind:"default"};radioGroupName="fixture-avatar";avatarErrorEl=null;avatarGridEl=null;
        refreshAvatarSelection(){}
        ${avatarMethod}
        render(parent){this.avatarGridEl=parent.createDiv({cls:"echoink-agent-avatar-grid"});this.renderAvatarOption("default","默认头像","data:image/svg+xml;charset=utf-8,"+encodeURIComponent(AGENT_AVATAR_PRESETS[0].assetPath),{kind:"default"});}
      }
      class ProviderFields {
        draft={name:"",apiKey:""}; providerId="deepseek"; apiKeyInput="";
        options={copy:{providers:{keyPlaceholder:"API key",savedKeyPlaceholder:"Saved key",showKey:"Show key",hideKey:"Hide key"}}};
        label(zh,en){return zh;} controlId(key){return "provider-fixture-"+key;}
        applyFieldAccessibility(){} renderFieldError(){} invalidatePreflight(){} clearFieldError(){}
        ${methods}
        render(parent){this.renderProviderNameField(parent);this.renderApiKeyField(parent);}
      }
      const test=new URLSearchParams(location.search).has("extras")?runThemeIsolationExtras(AvatarFields):runThemeIsolation(ProviderFields);
      test.catch(error=>{document.querySelector("#report").textContent=error.stack;document.querySelector("#report").dataset.result="failed";});
    `, resolveDir: rootDir, loader: "ts" },
    bundle: true, format: "esm", platform: "browser", define: { "process.env.NODE_ENV": '"development"' },
    outfile: path.join(directory, "regression.js"), logLevel: "silent", loader: {".md":"text",".txt":"text",".svg":"text"},
    plugins: [{name:"theme-isolation-host",setup(build){
      build.onResolve({filter:/^node:/},args=>({path:args.path,namespace:"theme-fixture"}));
      build.onResolve({filter:/core\/mapping$/},()=>({path:"format",namespace:"theme-fixture"}));
      build.onResolve({filter:/^obsidian$/},()=>({path:"host",namespace:"theme-fixture"}));
      build.onLoad({filter:/.*/,namespace:"theme-fixture"},async({path:name})=>{
        if(name.startsWith("node:")) return {contents:'export function createHash(){throw new Error("No backend in UI fixture");} export function existsSync(){throw new Error("No filesystem in UI fixture");} export function fileURLToPath(){throw new Error("No filesystem in UI fixture");}',loader:"js"};
        if(name==="format") {
          const ast=ts.createSourceFile("mapping.ts",await readFile(path.join(rootDir,"src/core/mapping.ts"),"utf8"),ts.ScriptTarget.Latest,true);
          const method=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==="formatContextTokenCount");
          return {contents:method.getText(ast),loader:"ts"};
        }
        return {contents:`export {Scope,Setting} from "./src/tests/origin-obsidian-dom-shim";
          import {Modal as HostModal} from "./src/tests/provider-discovery-dom-host";
          export class Modal extends HostModal {
            constructor(app){super(app);if(app.fixtureDocument) app.fixtureDocument.adoptNode(this.containerEl);}
            open(){this.modalEl.ownerDocument.body.append(this.containerEl);this.onOpen();}
          }
          export function setIcon(){}; export class TFile{}; export const Platform={isMobile:false}; export function normalizePath(path){return path;}; export function requestUrl(){throw new Error("Fixture cannot request network");}`,resolveDir:rootDir,loader:"js"};
      });
    }}]
  });
  // This committed source is immutable even after implementation/build rewrites.
  const baseline = execFileSync("git", ["show", "5eaba656d8d1c41dc930d316cb6dc61f1797eff9:styles.css"], {cwd:rootDir,encoding:"utf8",maxBuffer:4*1024*1024});
  await writeFile(path.join(directory,"baseline.css"),baseline);
  await writeFile(path.join(directory,"styles.css"),await readFile(path.join(rootDir,"styles.css")));
  await writeFile(path.join(directory,"index.html"),'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EchoInk immutable theme comparison</title><link rel="stylesheet" href="obsidian-app.css"><style id="shell">body{display:block;position:relative;contain:none;overflow:auto;width:100%;height:auto;min-height:100vh;margin:0;padding:16px}#fixture{width:900px;max-width:100%;margin:auto}#report{white-space:pre-wrap;font:12px/1.6 monospace}.echoink-settings-demo{padding:18px}.codex-container{height:200px}</style><style id="theme-before"></style><style id="product"></style><style id="theme-after"></style><main id="fixture"></main><pre id="report">Running…</pre><script type="module" src="regression.js"></script>');
  console.log(`Open ${path.join(directory,"index.html")}; report[data-result=passed] requires actual browser execution.`);
  process.exit(0);
}
if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "wiki-todo-dom") {
  const ts = await import("typescript");
  const source = await readFile(path.join(rootDir, "src/settings/settings-tab.ts"), "utf8");
  const ast = ts.createSourceFile("settings-tab.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "CodexSettingTab");
  const method = declaration.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === "mountKnowledgeDashboard").getText(ast);
  const directory = path.join(outputDir, "wiki-todo-dom");
  await mkdir(directory, { recursive: true });
  await esbuild.build({
    stdin: { contents: `import {runWikiTodoDom} from "./src/tests/wiki-todo-dom";
      import {renderKnowledgeFolderActions} from "./src/settings/knowledge-folder-actions";
      class Fixture {
        refreshes=0; knowledgeInitSection={showDashboard:false}; knowledgeDashboardSnapshot=null; knowledgeDashboardEl=null;
        service={folderOperationBusy:false,directoryWritable:true,folderOperationMessage:"",
          async getOriginalDirectoryStatus(){return {createdAt:1,files:2}},
          async restoreOriginalDirectories(){return {restored:1,skipped:[{path:"old.md",reason:"原位置已被占用"}]}},
          async optimizeFolderNames(){return {renamed:[],skipped:[]}}};
        plugin={settings:{settingsLanguage:"zh"},getKnowledgeSurfaceService:()=>this.service};
        scheduleDisplay(){this.refreshes++}; ${method}
      }
      runWikiTodoDom(Fixture).catch(error=>{document.querySelector("#report").textContent=error.stack;document.querySelector("#report").dataset.result="failed";});`, resolveDir: rootDir, loader: "ts" },
    bundle: true, format: "esm", platform: "browser", outfile: path.join(directory, "regression.js"), logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "wiki-todo-dom-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "host", namespace: "wiki-todo-fixture" }));
      build.onLoad({ filter: /.*/, namespace: "wiki-todo-fixture" }, () => ({ contents: `
        export {Scope} from "./src/tests/origin-obsidian-dom-shim";
        export function setIcon(){};
        export class Setting {
          constructor(parent){
            this.settingEl=parent.createDiv({cls:"setting-item"});
            this.infoEl=this.settingEl.createDiv({cls:"setting-item-info"});
            this.nameEl=this.infoEl.createDiv({cls:"setting-item-name"});
            this.descEl=this.infoEl.createDiv({cls:"setting-item-description"});
            this.controlEl=this.settingEl.createDiv({cls:"setting-item-control"});
          }
          setName(name){this.nameEl.setText(name);return this;}
          setDesc(description){this.descEl.setText(description);return this;}
        }`, resolveDir: rootDir, loader: "js" }));
    } }]
  });
  await writeFile(path.join(directory, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Wiki and todo UI checks</title><link rel="stylesheet" href="styles.css"><style>:root{--font-text-size:16px;--background-primary:white;--background-secondary:#f8f8f8;--text-normal:#333;--text-muted:#777;--interactive-accent:#52756e}body{font-family:sans-serif;margin:16px}main{max-width:100%}.setting-item{display:flex;align-items:center}.setting-item-info{flex:1}.setting-item-control{display:flex;align-items:center}</style><p id="report">Running</p><main id="settings" class="echoink-settings-demo"><div class="codex-settings-body"><div id="fixture" class="echoink-settings-page"></div></div></main><script type="module" src="regression.js"></script>');
  await writeFile(path.join(directory,"styles.css"), await readFile(path.join(rootDir,"styles.css")));
  console.log(`Open ${path.join(directory,"index.html")}`);
  process.exit(0);
}
if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "origin-dom") {
  const ts = await import("typescript");
  const source = await readFile(path.join(rootDir, "src/settings/settings-tab.ts"), "utf8");
  const ast = ts.createSourceFile("settings-tab.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "CodexSettingTab");
  const method = declaration.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === "runMcpToggleAction").getText(ast);
  const knowledge = declaration.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === "renderKnowledgeBaseSettings");
  const targets = knowledge?.body.statements.find((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(ast) === "availableTargets"));
  let modelDropdown;
  const findDropdown = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "addOriginDropdown") modelDropdown = node.arguments[1];
    ts.forEachChild(node, findDropdown);
  };
  if (knowledge) findDropdown(knowledge);
  if (!targets || !modelDropdown) throw new Error("Production current-model dropdown missing");
  const selectionHelpers = ["providerModelSelectionValue", "parseProviderModelSelectionValue"].map((name) => ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast)).join("\n");
  const settingsSource = await readFile(path.join(rootDir, "src/settings/settings.ts"), "utf8");
  const settingsAst = ts.createSourceFile("settings.ts", settingsSource, ts.ScriptTarget.Latest, true);
  const settingsHelpers = ["apiProviderHasUsableApiKey", "apiProviderHasUsableCredential", "getApiProviderModel", "activateApiProviderModel"].map((name) => settingsAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(settingsAst)).join("\n");
  const directory = path.join(outputDir, "origin-dom");
  await mkdir(directory, { recursive: true });
  await esbuild.build({
    stdin: { contents: `import {runOriginControlsDom} from "./src/tests/origin-controls-dom";
      import {OriginSetting} from "./src/settings/origin-setting";
      import {normalizeApiProviderId,apiProviderConfiguredDisplayName,apiProviderApiKeyRequired,getApiProviderPreset} from "./src/settings/provider-presets";
      import {renderProviderBrandIcon} from "./src/settings/provider-brand-icons";
      ${selectionHelpers}
      ${settingsHelpers}
      class Notice { constructor(message){} }
      class Fixture {
        activations=0; refreshes=0;
        plugin={settings:{settingsLanguage:"en"},activateApiProviderSettings:async (update)=>{update(this.plugin.settings);this.activations++;}};
        scheduleDisplay(){this.refreshes++} announceSettingsStatus(){} ${method}
        renderCurrentModel(parent,settings,app){
          this.plugin.settings=settings;
          const zh=true,copy={providers:{saveFailed:"Save failed"}};
          // Extract the actual production target filter and callback at build time.
          ${targets.getText(ast)}
          const row=new OriginSetting(parent).setName("EchoInk 当前模型").addOriginDropdown(app,${modelDropdown.getText(ast)});
          return row.controlEl.querySelector("[role=combobox]");
        }
      }
      runOriginControlsDom(Fixture).catch(error=>{document.querySelector("#report").textContent=error.stack;document.querySelector("#report").dataset.result="failed";});`, resolveDir: rootDir, loader: "ts" },
    bundle: true, format: "esm", platform: "browser", define: { "process.env.NODE_ENV": '"development"' },
    alias: { obsidian: path.join(rootDir, "src/tests/origin-obsidian-dom-shim.ts") },
    outfile: path.join(directory, "regression.js"), logLevel: "silent"
  });
  await writeFile(path.join(directory, "index.html"), '<!doctype html><meta charset="utf-8"><title>Origin controls regression</title><link rel="stylesheet" href="styles.css"><style>body{margin:0;padding:20px}:root{--font-text-size:16px}.modal.mod-settings{width:700px;max-width:100%;height:520px;margin:20px auto;overflow:hidden}.vertical-tab-content-container{height:100%}#fixture{max-width:656px}#report{white-space:pre-wrap;padding:20px;font:12px/1.8 monospace}.setting-item{display:flex}.echoink-settings-demo{padding:18px}</style><div class="modal mod-settings"><div class="vertical-tab-content-container"><div class="vertical-tab-content echoink-settings-host"><main id="fixture" class="echoink-settings-demo"></main></div></div></div><pre id="report">Running…</pre><script type="module" src="regression.js"></script>');
  await writeFile(path.join(directory, "styles.css"), await readFile(path.join(rootDir, "styles.css")));
  console.log(`Open ${path.join(directory, "index.html")}; #report[data-result=passed] is the browser result.`);
  process.exit(0);
}
if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "archive-ime") {
  const ts = await import("typescript");
  const source = await readFile(path.join(rootDir, "src/settings/settings-tab.ts"), "utf8");
  const ast = ts.createSourceFile("settings-tab.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "CodexSettingTab");
  const method = (name) => {
    const member = declaration?.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === name);
    if (!member) throw new Error(`Production method missing: ${name}`);
    return member.getText(ast);
  };
  const directory = path.join(outputDir, "archive-ime");
  await mkdir(directory, { recursive: true });
  await esbuild.build({
    stdin: { contents: `
      import {createSettingsPage,createSettingsSection,createSettingsCompactList,createSettingsState,showSettingsInlineConfirmation} from "./src/settings/settings-v2";
      import {runArchiveSearchImeRegression} from "./src/tests/archive-search-ime";
      import {createOriginInput,createOriginButton,disposeOriginControls} from "./src/settings/origin-controls";
      class ArchiveFixture {
        plugin={settings:{settingsLanguage:"zh-CN"}}; settingsVisible=true; displayFrame=null; displayFrameWindow=null;
        archivedConversationQuery=""; archivedConversationBusyId=""; archivedConversationsLoading=false; archivedConversationsError="";
        archivedConversations=[{conversationId:"test-1",title:"中文归档会话",updatedAt:1},{conversationId:"test-2",title:"English archive",updatedAt:1}];
        renders=0; constructor(public containerEl:HTMLElement){}
        // The shell adapter only empties the body and routes back to archives,
        // as renderSettingsContent does. Both event handling and frame scheduling
        // below are copied verbatim from the current production AST at build time.
        renderSettingsContent(){this.renders++;disposeOriginControls(this.containerEl);this.containerEl.empty();this.renderArchivedConversationSettings(this.containerEl);}
        ${method("renderArchivedConversationSettings")}
        ${method("scheduleDisplay")}
      }
      runArchiveSearchImeRegression(ArchiveFixture).catch(error=>{document.querySelector("#report").textContent=String(error);document.querySelector("#report").dataset.result="error";});
    `, resolveDir: rootDir, loader: "ts" },
    bundle: true, format: "esm", platform: "browser", outfile: path.join(directory, "regression.js"), logLevel: "silent",
    plugins: [{ name: "archive-native-dom-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "host", namespace: "archive-fixture" }));
      build.onLoad({ filter: /.*/, namespace: "archive-fixture" }, () => ({ contents: 'export function setIcon(){};export class Setting{};export {Scope} from "./src/tests/origin-obsidian-dom-shim";', resolveDir: rootDir, loader: "js" }));
    } }]
  });
  await writeFile(path.join(directory, "index.html"), '<!doctype html><meta charset="utf-8"><title>Archive search IME regression</title><main id="fixture" class="echoink-settings-demo"></main><pre id="report">Running native DOM regression…</pre><script type="module" src="regression.js"></script>');
  console.log(`Open ${path.join(directory, "index.html")}; #report[data-result=passed] is the browser result.`);
  process.exit(0);
}
if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "native-dom") {
  const directory = path.join(outputDir, "settings-native-dom");
  await mkdir(directory, { recursive: true });
  await esbuild.build({
    stdin: {
      contents: 'import {runSettingsNativeDomRegression} from "./src/tests/settings-native-dom"; try { runSettingsNativeDomRegression(document.querySelector("#fixture")); } catch(error) { document.querySelector("#fixture").textContent=String(error); document.querySelector("#fixture").dataset.nativeDomRegression="failed"; }',
      resolveDir: rootDir, loader: "ts"
    },
    bundle: true, format: "esm", platform: "browser",
    outfile: path.join(directory, "regression.js"), logLevel: "silent",
    plugins: [{ name: "native-dom-host-services", setup(build) {
      // Only non-DOM host services are stubbed; classList stays browser-native.
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "icons", namespace: "fixture" }));
      build.onResolve({ filter: /settings\/settings$/ }, () => ({ path: "ids", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: name }) => ({
        contents: name === "icons" ? 'export function setIcon() {};export {Scope} from "./src/tests/origin-obsidian-dom-shim";' : "export const newId = () => crypto.randomUUID();", resolveDir: rootDir, loader: "js"
      }));
    } }]
  });
  await writeFile(path.join(directory, "index.html"), '<!doctype html><meta charset="utf-8"><title>Native settings DOM regression</title><link rel="stylesheet" href="../../styles.css"><style>:root{--font-text-size:16px;--font-interface:sans-serif;--background-primary:white;--text-normal:#333}main{width:790px;max-width:100%;margin:auto}</style><main class="echoink-settings-demo"><div id="fixture"></div><div class="codex-resource-body"><div class="codex-resource-row"><div class="codex-resource-row-content">Skill enabled</div><input class="codex-resource-toggle" type="checkbox" checked aria-label="Enabled skill"></div><div class="codex-resource-row"><div class="codex-resource-row-content">MCP disabled</div><input class="codex-resource-toggle" type="checkbox" aria-label="Disabled MCP"></div></div></main><script type="module" src="regression.js"></script>');
  console.log(`Open ${path.join(directory, "index.html")} in a real browser; #fixture[data-native-dom-regression=passed] is the result.`);
  process.exit(0);
}
await esbuild.build({
  entryPoints: ["src/tests/provider-settings-behavior.ts"],
  absWorkingDir: rootDir,
  bundle: true,
  loader: {
    ".md": "text",
    ".svg": "dataurl",
    ".webp": "dataurl"
  },
  platform: "node",
  target: "node22",
  format: "esm",
  banner: { js: 'import { createRequire as createSettingsTestRequire } from "node:module"; const require = createSettingsTestRequire(import.meta.url);' },
  external: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "yaml"
  ],
  plugins: [{
    name: "provider-settings-test-shims",
    setup(build) {
      build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(rootDir, "src/tests/origin-controls-shim.ts") }));
      build.onResolve({ filter: /(?:^|\/)origin-setting$/ }, () => ({ path: path.join(rootDir, "src/tests/origin-setting-shim.ts") }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: obsidianShimPath
      }));
    }
  }],
  outfile: outputFile,
  logLevel: "silent"
});

const result = spawnSync(process.execPath, [outputFile], {
  cwd: rootDir,
  env: {
    ...process.env,
    ECHOINK_DISABLE_ACP: "1",
    PI_OFFLINE: "1"
  },
  stdio: "inherit"
});

process.exit(result.status ?? 1);
