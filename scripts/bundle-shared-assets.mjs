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
export async function sharedAssetsBundle(minify) {
  const result = await esbuild.build({ stdin: { contents: `${await financeBrandsSource()}\n${await agentAvatarAssetsSource()}`, resolveDir: process.cwd(), sourcefile: "shared-artwork.js" }, bundle: true, write: false, format: "iife", globalName: "__echoinkSharedAssets", platform: "browser", target: "es2022", minify });
  return result.outputFiles[0].text;
}
