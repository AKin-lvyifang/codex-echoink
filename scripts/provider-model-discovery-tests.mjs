import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import esbuild from "esbuild";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
if (!process.argv.includes("--browser")) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/provider-settings-tests.mjs")], { cwd: root, env: { ...process.env, ECHOINK_PROVIDER_SETTINGS_CASE: "dynamic-discovery" }, stdio: "inherit" });
  process.exit(result.status ?? 1);
}
const output = path.join(root, ".tmp/provider-discovery-ui");
await mkdir(output, { recursive: true });
const source = await readFile(path.join(root, "src/plugin/pi-provider-configuration-service.ts"), "utf8");
const ast = ts.createSourceFile("service.ts", source, ts.ScriptTarget.Latest, true);
const functions = ["requestProviderModels", "abortableProviderRequest"].map((name) => ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast)).join("\n");
// Keep production function bodies intact, excluding unrelated Node-only settings
// features. Full settings normalization and SDK requests are covered by Node tests.
const settingsSource = await readFile(path.join(root, "src/settings/settings.ts"), "utf8");
const settingsAst = ts.createSourceFile("settings.ts", settingsSource, ts.ScriptTarget.Latest, true);
const declarations = new Map();
for (const statement of settingsAst.statements) {
  if (ts.isFunctionDeclaration(statement) && statement.name) declarations.set(statement.name.text, statement);
  if (ts.isVariableStatement(statement)) for (const item of statement.declarationList.declarations) if (ts.isIdentifier(item.name)) declarations.set(item.name.text, statement);
}
const selected = new Set();
const include = (name) => {
  const node = declarations.get(name);
  if (!node || selected.has(node)) return;
  selected.add(node);
  const visit = (child) => { if (ts.isIdentifier(child)) include(child.text); ts.forEachChild(child, visit); };
  ts.forEachChild(node, visit);
};
for (const name of ["createApiProviderConfig", "createApiProviderModelConfig", "createDiscoveredApiProviderModelConfig", "applyApiProviderModelLimitsOverride", "apiProviderModelSupportsImage", "getApiProviderModel", "getDefaultApiProviderModel", "setApiProviderDefaultModel", "isValidApiProviderModelConfig", "isValidApiProviderModelId", "normalizeStoredApiProviderModel"]) include(name);
const settingsExcerpt = `import * as presets from "./src/settings/provider-presets";
  import * as catalog from "./src/settings/pi-model-catalog";
  import {normalizeDiscoveredProviderModel} from "./src/settings/provider-model-discovery";
  const {getApiProviderPreset,getApiProviderModelPreset,normalizeApiProviderId,apiProviderMaxOutputReserve}=presets;
  const {normalizeEchoInkReasoningEffort,resolveEchoInkPiCatalogModel}=catalog;
  ${[...selected].map((node) => node.getText(settingsAst)).join("\n")}
  export {normalizeStoredApiProviderModel};`;
const piSource = await readFile(path.join(root, "node_modules/@earendil-works/pi-ai/dist/models.js"), "utf8");
const piAst = ts.createSourceFile("models.js", piSource, ts.ScriptTarget.Latest, true);
const piExcerpt = 'const EXTENDED_THINKING_LEVELS=["off","minimal","low","medium","high","xhigh","max"];\n' + ["getSupportedThinkingLevels", "clampThinkingLevel"].map((name) => piAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(piAst)).join("\n");
await esbuild.build({ stdin: { contents: `
  import {runProviderDiscoveryDom} from "./src/tests/provider-discovery-dom";
  import {apiProviderModelsUrl} from "./src/settings/provider-presets";
  import {parseProviderModelResponse} from "./src/settings/provider-model-discovery";
  const PROVIDER_REQUEST_TIMEOUT_MS=10000;
  ${functions}
  runProviderDiscoveryDom((draft,body,status)=>requestProviderModels({draft,apiKey:"browser-fixture-fake-key",fetchImpl:async()=>({status,json:async()=>structuredClone(body)})}));
`, resolveDir: root, loader: "ts" }, bundle: true, platform: "browser", format: "esm", define: { "process.env.NODE_ENV": '"development"' }, alias: { obsidian: path.join(root, "src/tests/provider-discovery-dom-host.ts") }, plugins: [{name:"production-function-browser-adapter",setup(build){
  build.onResolve({filter:/^(?:\.\/|\.\.\/)?(?:settings\/)?settings$/},()=>({path:"settings",namespace:"fixture-functions"}));
  build.onResolve({filter:/^@earendil-works\/pi-ai$/},()=>({path:"pi-levels",namespace:"fixture-functions"}));
  build.onLoad({filter:/.*/,namespace:"fixture-functions"},({path:name})=>({contents:name==="settings"?settingsExcerpt:piExcerpt,resolveDir:root,loader:"ts"}));
}}], outfile: path.join(output, "fixture.js"), logLevel: "silent" });
await writeFile(path.join(output, "styles.css"), await readFile(path.join(root, "styles.css")));
await writeFile(path.join(output, "index.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Provider discovery regression</title><link rel="stylesheet" href="styles.css"><style>
 :root{--font-text-size:16px;--font-interface:-apple-system,BlinkMacSystemFont,sans-serif;--font-text:var(--font-interface);--font-monospace:monospace;--text-normal:#303238;--text-muted:#73767e;--text-faint:#999;--background-primary:#fff;--background-secondary:#f7f7f9;--background-modifier-border:#e6e7eb;--interactive-accent:#7860b3;--text-on-accent:#fff;--background-modifier-hover:#f2f2f4;--input-radius:6px;--input-height:32px}
 body{margin:0;font-family:var(--font-interface);color:var(--text-normal);background:#f5f5f6}#fixture-tools{position:fixed;top:8px;left:8px;z-index:1000;font-size:12px;display:flex;gap:8px;align-items:center}#fixture-tools button,#fixture-tools select{font-size:12px;padding:6px}#report{position:fixed;bottom:4px;left:8px;font-size:12px;z-index:1000}.modal-container{display:flex;justify-content:center;align-items:flex-start;padding:56px 16px 40px}.modal{width:min(780px,100%);background:white;border:1px solid #e6e7eb;border-radius:12px;padding:20px;box-sizing:border-box}.modal-title{font-size:18px;font-weight:600;margin-bottom:16px}.modal-content{overflow:auto;max-height:calc(100vh - 180px)}button{cursor:pointer;font-family:inherit}
 </style><div id="fixture-tools"><button id="fixture-new">新建 API</button><button id="fixture-reopen">重开已保存</button><label>受控响应 <select id="fixture-response"><option value="rich">官方丰富响应</option><option value="id-only">只有 ID</option><option value="empty">空列表</option><option value="partial">未完成分页</option><option value="failure">服务错误</option></select></label></div><div id="report">浏览器宿主模拟；无真实 Provider/Vault。</div><script type="module" src="fixture.js"></script></html>`);
console.log(`Browser fixture ready: ${output}/index.html`);
