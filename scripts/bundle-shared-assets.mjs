import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import esbuild from "esbuild";
import { deflateRawSync } from "node:zlib";

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
export async function sharedAssetsBundle(minify) {
  const result = await esbuild.build({ stdin: { contents: await financeBrandsSource(), resolveDir: process.cwd(), sourcefile: "finance-artwork.js" }, bundle: true, write: false, format: "iife", globalName: "__echoinkSharedAssets", platform: "browser", target: "es2022", minify });
  return result.outputFiles[0].text;
}
