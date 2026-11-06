import vm from "node:vm";
import esbuild from "esbuild";

// Reuse the current Obsidian DOM factories, including Document.win for owned nodes.
const host = await esbuild.build({ entryPoints: ["src/tests/obsidian-dom.ts"], bundle: true, write: false, format: "cjs", platform: "browser", logLevel: "silent" });
export function installMobileDomHost(window) {
  const module = { exports: {} };
  vm.runInNewContext(host.outputFiles[0].text, { module, exports: module.exports, window, document: window.document });
  module.exports.installObsidianDom(window);
  const prototype = window.HTMLElement.prototype;
  if (!prototype.createEl) prototype.createEl = function(tag, options, callback) { const node = window.createEl(tag, options, callback); this.appendChild(node); return node; };
  if (!prototype.createDiv) prototype.createDiv = function(options, callback) { return this.createEl("div", options, callback); };
  if (!prototype.createSpan) prototype.createSpan = function(options, callback) { return this.createEl("span", options, callback); };
  if (!prototype.empty) prototype.empty = function() { this.replaceChildren(); };
  if (!prototype.setText) prototype.setText = function(value) { this.textContent = value; };
}
