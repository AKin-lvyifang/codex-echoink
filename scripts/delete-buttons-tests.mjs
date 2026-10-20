import { createRequire } from "node:module";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
if (!process.env.ECHOINK_DELETE_BUTTON_TEST_ROOT?.trim()) throw new Error("Explicit ECHOINK_DELETE_BUTTON_TEST_ROOT is required");
const allowed = await realpath(path.join(os.homedir(), "EchoInk-TestVaults", "90-任务临时"));
const fixture = await realpath(path.resolve(process.env.ECHOINK_DELETE_BUTTON_TEST_ROOT));
if (!fixture.startsWith(allowed + path.sep)) throw new Error("Onboarding Agent editor fixtures must stay in the explicit disposable test root");
const run = await mkdtemp(path.join(fixture, ".delete-buttons-run-"));
const { JSDOM } = createRequire(import.meta.url)("jsdom");
let dom;
try {
  const output = path.join(run, "delete-buttons.mjs");
  await esbuild.build({ entryPoints: [path.join(root, "src/tests/delete-buttons.ts")], bundle: true, platform: "node", format: "esm", target: "node22", outfile: output, logLevel: "silent",
    loader: { ".svg": "dataurl", ".md": "text", ".txt": "text" },
    plugins: [{ name: "delete-buttons-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "delete-host", namespace: "delete-host" }));
      build.onLoad({ filter: /.*/, namespace: "delete-host" }, () => ({ contents: `
        export * from ${JSON.stringify(path.join(root, "src/tests/obsidian-shim.ts"))};
        export function setIcon(element, name) { element.replaceChildren(); const svg=element.ownerDocument.createElementNS("http://www.w3.org/2000/svg","svg"); svg.setAttribute("data-icon",name); element.append(svg); }
      `, resolveDir: root }));
      build.onResolve({ filter: /^[^./]/ }, args => {
        const resolved = import.meta.resolve(args.path);
        return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
      });
    } }]
  });
  dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://delete-buttons.invalid" });
  const win = dom.window;
  for (const name of ["window", "document", "navigator", "Element", "Node", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "SVGElement", "SVGSVGElement", "DOMParser", "XMLSerializer", "FileReader", "ShadowRoot", ...Object.getOwnPropertyNames(win).filter(name => /^HTML.*Element$/.test(name))])
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? win : win[name] });
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  const tests = await import(pathToFileURL(output).href);
  await tests.runDeleteButtonTests();
} finally {
  dom?.window.close();
  await rm(run, { recursive: true, force: true });
}
