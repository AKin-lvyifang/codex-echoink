import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";

// Pure DOM checks: compile in memory, never create a disk fixture or touch a Vault.
const root = fileURLToPath(new URL("../", import.meta.url));
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://generation-ui.invalid" });
const win = dom.window;
for (const name of ["window", "document", "navigator", "Element", "Node", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "SVGElement", "DOMParser", "DOMRect", ...Object.getOwnPropertyNames(win).filter(name => /^HTML.*Element$/.test(name))]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? win : win[name] });
}
globalThis.getComputedStyle = win.getComputedStyle.bind(win);
globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win);
globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
win.HTMLElement.prototype.scrollIntoView = function () {};
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.ResizeObserver = win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
try {
  const bootstrap = ts.createSourceFile("bootstrap.ts", await readFile(path.join(root, "src/plugin/bootstrap.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const fileMenu = bootstrap.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "registerGenerationFileMenu");
  if (!fileMenu) throw new Error("Production generation file-menu registration is missing");
  const result = await esbuild.build({ stdin: { contents: `import {runGenerationTemplateTests} from "./src/tests/generation-templates";
    import {runGenerationUiTests,runGenerationModalTests,runGenerationComposerEntryTests,runGenerationFileMenuTests} from "./src/tests/generation-ui";
    import {Platform,Notice} from "obsidian";
    class TFile { constructor(public path:string){} get extension(){return this.path.split(".").at(-1)??"";} }
    class TFolder { constructor(public path:string){} }
    const getGenerationService = plugin => plugin.generationService;
    ${fileMenu.getText(bootstrap)}
    export async function runTests(){runGenerationTemplateTests(); await runGenerationUiTests(); await runGenerationModalTests(); runGenerationComposerEntryTests(); await runGenerationFileMenuTests(registerGenerationFileMenu,TFile,TFolder); console.log("Generation templates, settings, modal, composer and file-menu UI checks passed");}`, resolveDir: root, loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", target: "node22", logLevel: "silent",
    loader: { ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl", ".md": "text" },
    plugins: [{ name: "generation-ui-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "host", namespace: "generation-host" }));
      build.onLoad({ filter: /.*/, namespace: "generation-host" }, () => ({ resolveDir: root, loader: "ts", contents: 'export {Scope,Setting} from "./src/tests/origin-obsidian-dom-shim"; import {Modal as HostModal} from "./src/tests/provider-discovery-dom-host"; import {Scope} from "./src/tests/origin-obsidian-dom-shim"; export class Modal extends HostModal { scope = new Scope(); } export {setIcon,setTooltip,Notice} from "./src/tests/provider-discovery-dom-host"; export const Platform = {isDesktopApp:true,isMobile:false}; export class TFile{}; export class Menu{}; export function normalizePath(path){return path;}' }));
    } }]
  });
  const testModule = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text + "\n//# sourceURL=generation-ui-tests.bundle.cjs")(createRequire(path.join(root, "package.json")), testModule, testModule.exports);
  await testModule.exports.runTests();
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
finally { dom.window.close(); }
