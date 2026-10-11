import assert from "node:assert/strict";
import vm from "node:vm";
import esbuild from "esbuild";
import { originalFinanceBrands, sharedAssetsBundle, financeBrandsPlugin } from "../../scripts/bundle-shared-assets.mjs";
const original = await originalFinanceBrands();
const shared = await sharedAssetsBundle(true);
const context = vm.createContext({ atob, btoa });
vm.runInContext(shared, context);
const getter = vm.runInContext("__echoinkSharedAssets.financeBrands", context);
assert.equal(getter(), getter());
assert.deepEqual(JSON.parse(JSON.stringify(getter())), original);
for (const platform of ["browser", "node"]) {
  const result = await esbuild.build({ stdin: { contents: 'export {FINANCE_BRAND_ASSETS} from "./src/lifestyle/finance-brand-assets";', resolveDir: process.cwd() }, bundle: true, write: false, format: "cjs", platform, plugins: [financeBrandsPlugin(true)], minify: true });
  context.module = { exports: {} }; context.exports = context.module.exports;
  vm.runInContext(result.outputFiles[0].text, context);
  assert.equal(context.module.exports.FINANCE_BRAND_ASSETS, getter());
}
console.log(`PASS finance artwork: all ${original.length} original dataURIs and metadata, shared singleton in browser + desktop; decoder ${Buffer.byteLength(shared)} bytes`);
