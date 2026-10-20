import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import esbuild from "esbuild";
import { deflateRawSync } from "node:zlib";
import vm from "node:vm";

function literal(node) {
  if (ts.isStringLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.filter(item => !ts.isSpreadElement(item)).map(literal);
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(item => {
    if (!ts.isPropertyAssignment(item) || !(ts.isIdentifier(item.name) || ts.isStringLiteral(item.name))) throw new Error("Unexpected finance artwork literal");
    return [item.name.text, literal(item.initializer)];
  }));
  throw new Error("Unexpected finance artwork expression");
}
export async function originalFinanceBrands() {
  const catalog = [];
  for (const [file, name] of [["finance-brand-assets.ts", "FINANCE_BRAND_ASSETS"], ["finance-brand-supplement.ts", "FINANCE_BRAND_SUPPLEMENT"]]) {
    const source = await fs.readFile(`src/lifestyle/${file}`, "utf8");
    const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declaration = syntax.statements.filter(ts.isVariableStatement).flatMap(item => item.declarationList.declarations).find(item => item.name.getText(syntax) === name);
    if (!declaration?.initializer) throw new Error(`Missing ${name}`);
    catalog.push(...literal(declaration.initializer));
  }
  if (catalog.length !== 172 || new Set(catalog.map(item => item.id)).size !== catalog.length) throw new Error("Finance artwork catalog changed; review sharing");
  return catalog;
}
export async function financeBrandsSource() {
  const catalog = await originalFinanceBrands();
  const compact = catalog.map(item => {
    if (!item.dataUri.startsWith("data:image/svg+xml;base64,")) return item;
    const raw = Buffer.from(item.dataUri.split(",")[1], "base64").toString("utf8");
    if (`data:image/svg+xml;base64,${Buffer.from(raw).toString("base64")}` !== item.dataUri) throw new Error(`Artwork bytes cannot be restored: ${item.id}`);
    return { ...item, dataUri: raw, svg: true };
  });
  const encoded = deflateRawSync(Buffer.from(JSON.stringify(compact)), { level: 9 }).toString("base64");
  return `import {inflateSync,strFromU8,strToU8} from "fflate";
let catalog;
export function financeBrands(){
 if(!catalog){const packed=Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0));catalog=JSON.parse(strFromU8(inflateSync(packed))).map(item=>{
 if(!item.svg)return item;const bytes=strToU8(item.dataUri);let binary="";for(let start=0;start<bytes.length;start+=8192)binary+=String.fromCharCode(...bytes.subarray(start,start+8192));const {svg,...asset}=item;return {...asset,dataUri:"data:image/svg+xml;base64,"+btoa(binary)};});}
 return catalog;
}`;
}
export function financeBrandsPlugin(shared = false) {
  return { name: "echoink-finance-artwork-storage", setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]lifestyle[\\/]finance-brand-assets\.ts$/ }, () => ({ contents:
      `${shared ? "" : 'import {financeBrands} from "echoink-finance-artwork";'}\nexport const FINANCE_BRAND_ASSETS=${shared ? "__echoinkSharedAssets.financeBrands()" : "financeBrands()"}; export const FINANCE_BRAND_ASSETS_BY_ID=new Map(FINANCE_BRAND_ASSETS.map(asset=>[asset.id,asset]));`, loader: "js" }));
    build.onResolve({ filter: /^echoink-finance-artwork$/ }, () => ({ path: "finance-artwork", namespace: "echoink-assets" }));
    build.onLoad({ filter: /.*/, namespace: "echoink-assets" }, async () => ({ contents: await financeBrandsSource(), loader: "js", resolveDir: process.cwd() }));
  } };
}
export async function originalAgentAvatarAssets() {
  const source = await fs.readFile("src/ui/agent-avatar-presets.ts", "utf8");
  const syntax = ts.createSourceFile("agent-avatar-presets.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const paths = syntax.statements.filter(ts.isImportDeclaration).map(node => node.moduleSpecifier.text).filter(file => file.endsWith(".svg")).map(file => path.resolve("src/ui", file));
  if (paths.length !== 15 || new Set(paths).size !== 15) throw new Error("Agent avatar catalog changed; review sharing");
  const contents = paths.map((file, i) => `import a${i} from ${JSON.stringify(file)};`).join("\n") + `\nexport const assets=[${paths.map((_, i) => `a${i}`).join(",")}];`;
  const build = await esbuild.build({ stdin: { contents, resolveDir: process.cwd(), loader: "js" }, loader: { ".svg": "dataurl" }, bundle: true, write: false, format: "cjs", logLevel: "silent" });
  const module = { exports: {} }; vm.runInNewContext(build.outputFiles[0].text, { module, exports: module.exports });
  return { paths, assets: module.exports.assets };
}
export async function agentAvatarAssetsSource() {
  const { assets } = await originalAgentAvatarAssets();
  // SVG paths alternate x/y coordinates. Store exact integer text as deltas
  // from the preceding coordinate on the same axis before the existing deflate.
  // Noncanonical integers stay literal, preserving leading zeros and all bytes.
  const text = JSON.stringify(assets), numbers = [], deltas = [];
  if (text.includes("\0")) throw new Error("Unexpected null in avatar URL");
  const template = text.replace(/\d+/g, token => {
    const value = Number(token), previous = numbers[numbers.length - 2] ?? 0;
    deltas.push(Number.isSafeInteger(value) && String(value) === token ? value - previous : token);
    numbers.push(value); return "\0";
  });
  const encoded = deflateRawSync(Buffer.from(JSON.stringify([template, deltas])), { level: 9 }).toString("base64");
  return `import {inflateSync as avatarInflate,strFromU8 as avatarString} from "fflate";
let avatars;export function agentAvatarAssets(){if(!avatars){const [template,deltas]=JSON.parse(avatarString(avatarInflate(Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0)))));const numbers=[];for(const delta of deltas)numbers.push(typeof delta==="string"?delta:String(delta+Number(numbers[numbers.length-2]??0)));let index=0;avatars=JSON.parse(template.replace(/\\0/g,()=>numbers[index++]));}return avatars;}`;
}
export function agentAvatarAssetsPlugin(shared = false) {
  return { name: "echoink-agent-avatar-storage", setup(build) {
    let original;
    build.onLoad({ filter: /[\\/]assets[\\/]avatars[\\/]monochrome-round-set-01[\\/].*\.svg$/ }, async args => {
      const { paths } = await (original ??= originalAgentAvatarAssets()); const index = paths.indexOf(args.path);
      if (index < 0) return;
      return { contents: `${shared ? "" : 'import {agentAvatarAssets} from "echoink-agent-avatar-artwork";'}export default ${shared ? "__echoinkSharedAssets.agentAvatarAssets()" : "agentAvatarAssets()"}[${index}];`, loader: "js" };
    });
    build.onResolve({ filter: /^echoink-agent-avatar-artwork$/ }, () => ({ path: "agent-avatars", namespace: "echoink-agent-avatars" }));
    build.onLoad({ filter: /.*/, namespace: "echoink-agent-avatars" }, async () => ({ contents: await agentAvatarAssetsSource(), loader: "js", resolveDir: process.cwd() }));
  } };
}
const profileStringFiles = ["src/harness/memory/agent-templates.ts", "src/harness/memory/agent-self-model.ts", "src/ui/agent-identity-modal.ts", "src/ui/agent-avatar-processor.ts"];
async function profileStringData() {
  const values = [], sources = new Map();
  for (const file of profileStringFiles) {
    const source = await fs.readFile(file, "utf8"), tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), literals = [];
    const visit = node => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && Buffer.byteLength(node.text) >= 64
        && node.parent.name !== node && !ts.isLiteralTypeNode(node.parent) && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) {
        let index = values.indexOf(node.text); if (index < 0) { index = values.length; values.push(node.text); }
        literals.push({ start: node.getStart(tree), end: node.end, index });
      }
      ts.forEachChild(node, visit);
    };
    visit(tree); sources.set(path.resolve(file), { source, literals });
  }
  return { values, sources };
}
async function profileStringsSource() {
  const { values } = await profileStringData();
  const bytes = JSON.stringify(values), encoded = deflateRawSync(Buffer.from(bytes), { level: 9 }).toString("base64");
  return `import {inflateSync as profileInflate,strFromU8 as profileString} from "fflate";let profileText;export function profileStrings(){return profileText??=(JSON.parse(profileString(profileInflate(Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0))))));}`;
}
/** Same template/current-self/avatar text restored once for both platform loaders. */
export function profileStringsPlugin(shared = false) {
  return { name: "echoink-shared-profile-text", setup(build) {
    let data;
    build.onLoad({ filter: /[\\/]src[\\/](?:harness[\\/]memory[\\/]agent-(?:templates|self-model)|ui[\\/]agent-(?:identity-modal|avatar-processor))\.ts$/ }, async args => {
      const { sources } = await (data ??= profileStringData()), item = sources.get(args.path); if (!item) return;
      let contents = shared ? "const __echoinkProfileText=__echoinkSharedAssets.profileStrings();\n" : 'import {profileStrings} from "echoink-profile-text";const __echoinkProfileText=profileStrings();\n'; let cursor = 0;
      for (const literal of item.literals) { contents += item.source.slice(cursor, literal.start) + `__echoinkProfileText[${literal.index}]`; cursor = literal.end; }
      return { contents: contents + item.source.slice(cursor), loader: "ts", resolveDir: path.dirname(args.path) };
    });
    build.onResolve({ filter: /^echoink-profile-text$/ }, () => ({ path: "profile-text", namespace: "echoink-profile-text" }));
    build.onLoad({ filter: /.*/, namespace: "echoink-profile-text" }, async () => ({ contents: await profileStringsSource(), loader: "js", resolveDir: process.cwd() }));
  } };
}
// Only this browser-safe identity/Profile surface is shared. Names are explicit
// so a new public API cannot silently expand the common runtime.
export const profileSharedModules = new Map([
  ["src/harness/memory/agent-identity-model.ts", ["AGENT_IDENTITY_STATE_SCHEMA", "AGENT_IDENTITY_RELATIVE_PATH", "DEFAULT_AGENT_DISPLAY_NAME", "AGENT_DISPLAY_NAME_MAX_CHARS", "AGENT_AVATAR_DATA_URL_MAX_CHARS", "countUnicodeChars", "normalizeAgentDisplayName", "normalizeAgentAvatar", "defaultAgentIdentityState", "parseAgentIdentityState"]],
  ["src/harness/memory/agent-templates.ts", ["AGENT_TEMPLATE_IDS", "isAgentTemplateId", "AGENT_TEMPLATES", "getAgentTemplate"]],
  ["src/harness/memory/agent-self-model.ts", ["AGENT_MD_HARD_MAX_BYTES", "USER_MD_HARD_MAX_BYTES", "CURRENT_SELF_START", "CURRENT_SELF_END", "EMPTY_HABITS_SENTINEL", "stableSelfKey", "normalizeAgentSelf", "agentSelfFromTemplate", "applyAgentSelfOperations", "renderCurrentSelfBlock", "renderAgentMarkdown", "parseAgentCurrentSelf", "replaceAgentCurrentSelf", "renderBaseAgentMarkdown", "publicAgentSelfProfile", "assertUtf8HardLimit"]],
  ["src/harness/memory/agent-self-metadata-model.ts", ["AGENT_SELF_METADATA_SCHEMA", "AGENT_SELF_METADATA_RELATIVE_PATH", "emptyAgentSelfMetadata", "parseAgentSelfMetadata", "agentSelfMetadataJson", "reconcileAgentSelfDerivationSources"]],
  ["src/ui/agent-identity-modal.ts", ["AgentIdentityModal"]],
  ["src/ui/agent-avatar-processor.ts", ["AGENT_AVATAR_SOURCE_MAX_BYTES", "AGENT_AVATAR_SOURCE_MAX_EDGE", "AGENT_AVATAR_OUTPUT_EDGE", "AGENT_AVATAR_OUTPUT_MAX_DATA_URL_CHARS", "AGENT_AVATAR_WEBP_QUALITY", "AGENT_AVATAR_ACCEPTED_TYPES", "AvatarProcessingError", "validateAvatarSourceType", "validateAvatarSourceSize", "validateAvatarDataUrl", "validateAgentAvatarSvg", "processAgentAvatar", "createBrowserAvatarRenderer"]],
  // These are the existing Modal's small DOM helpers, without business changes.
  ["src/ui/agent-avatar-presets.ts", ["DEFAULT_AGENT_AVATAR_PRESET_ID", "AGENT_AVATAR_PRESETS", "resolveAgentAvatarPresetAsset", "resolveAgentAvatarUrl"]],
  ["src/settings/amicro-buttons.ts", ["applyAmicroButton", "applyDeleteButton", "applyParticleButton", "triggerParticleButton", "setAmicroButtonPending", "confirmAmicroButton"]],
  ["src/ui/animate-icon.ts", ["renderAnimateIcon"]],
  ["src/utils/sha256.ts", ["sha256Hex"]]
]);

export function profileModulesPlugin() {
  const proxies = new Map([...profileSharedModules].map(([file, names], index) => [path.resolve(file),
    `const profile=__echoinkSharedAssets.profileModules().m${index};\n${names.map(name => `export const ${name}=profile.${name};`).join("\n")}`]));
  return { name: "echoink-shared-profile-modules", setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/].*\.ts$/ }, args => {
      const contents = proxies.get(args.path);
      if (contents) return { contents, loader: "js" };
    });
  } };
}

async function profileModulesSource(minify) {
  const contents = [...profileSharedModules].map(([file, names], index) =>
    `import {${names.join(",")}} from ${JSON.stringify(path.resolve(file))}; export const m${index}={${names.join(",")}};`).join("\n");
  const result = await esbuild.build({ stdin: { contents, resolveDir: process.cwd(), sourcefile: "shared-profile.js" }, bundle: true, write: false, format: "cjs", platform: "browser", target: "es2022", external: ["obsidian"], loader: { ".svg": "dataurl" }, plugins: [agentAvatarAssetsPlugin(true), profileStringsPlugin(true)], minify, metafile: true, logLevel: "silent" });
  await fs.mkdir(".tmp", { recursive: true });
  await fs.writeFile(".tmp/profile-production-metafile.json", JSON.stringify(result.metafile));
  // A normal function keeps Obsidian imports and module initialization lazy.
  // It contains compiled code directly; no evaluation or serialized code.
  return `let profileModulesCache;export function profileModules(){return profileModulesCache??=(function(){var module={exports:{}};var exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;})();}`;
}

export async function sharedAssetsBundle(minify) {
  const result = await esbuild.build({ stdin: { contents: `${await financeBrandsSource()}\n${await agentAvatarAssetsSource()}\n${await profileStringsSource()}\n${await profileModulesSource(minify)}`, resolveDir: process.cwd(), sourcefile: "shared-artwork.js" }, bundle: true, write: false, format: "iife", globalName: "__echoinkSharedAssets", platform: "browser", target: "es2022", external: ["obsidian"], minify });
  return result.outputFiles[0].text;
}
