import { desktopNodeTestBanner } from "./desktop-node-test-host.mjs";
import { createRequire } from "node:module";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { disposableTestRoot } from "./disposable-test-root.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
if (!process.env.ECHOINK_AGENT_EDITOR_TEST_ROOT?.trim() && !process.env.ECHOINK_TEST_ROOT?.trim()) throw new Error("An explicit disposable test root is required");
const fixture = await realpath(disposableTestRoot(path.join(os.homedir(), "EchoInk-TestVaults", "90-任务临时"), ["ECHOINK_AGENT_EDITOR_TEST_ROOT"]));
const run = await mkdtemp(path.join(fixture, ".agent-editor-run-"));
const { JSDOM } = createRequire(import.meta.url)("jsdom");
let dom;
try {
  const output = path.join(run, "agent-editor.mjs");
  await esbuild.build({ banner: desktopNodeTestBanner, entryPoints: [path.join(root, "src/tests/agent-editor.ts")], bundle: true, platform: "node", format: "esm", target: "node22", outfile: output, logLevel: "silent",
    loader: { ".svg": "dataurl", ".md": "text", ".txt": "text" },
    plugins: [{ name: "agent-editor-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => {
        const resolved = import.meta.resolve(args.path);
        return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
      });
    } }]
  });
  dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://agent-editor.invalid" });
  const win = dom.window;
  for (const name of ["window", "document", "navigator", "Element", "Node", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "SVGElement", "SVGSVGElement", "DOMParser", "XMLSerializer", "FileReader", "ShadowRoot", ...Object.getOwnPropertyNames(win).filter(name => /^HTML.*Element$/.test(name))])
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? win : win[name] });
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  const tests = await import(pathToFileURL(output).href);
  await tests.runAgentEditorTests(win);
} finally {
  dom?.window.close();
  await rm(run, { recursive: true, force: true });
}
