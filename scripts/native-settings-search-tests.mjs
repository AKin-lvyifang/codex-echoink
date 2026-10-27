import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
// Reuse an existing DOM runtime; this test adds no production dependency.
const { JSDOM } = require(process.env.ECHOINK_JSDOM_PATH || "jsdom");
const directory = path.join(process.env.ECHOINK_SETTINGS_TEST_ROOT || path.join(root, ".tmp"), "native-settings-search");
await mkdir(directory, { recursive: true });
try {
  const entry = path.join(directory, "test.mjs");
  await esbuild.build({
    entryPoints: ["src/tests/settings-search-dom.ts"], absWorkingDir: root,
    bundle: true, platform: "node", target: "node22", format: "esm", outfile: entry, sourcemap: "inline",
    banner: { js: `import {createRequire} from "node:module"; const require = createRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    plugins: [{ name: "external-package-location", setup(build) {
      build.onResolve({ filter: /^(@earendil-works\/pi-(agent-core|ai|coding-agent)(\/|$)|yaml$)/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }));
    } }],
    alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") },
    logLevel: "silent"
  });
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://settings-fixture.invalid" });
  const win = dom.window;
  for (const name of ["window", "document", "navigator", "Element", "Node", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "SVGElement", "SVGSVGElement", "DOMParser", ...Object.getOwnPropertyNames(win).filter(name => /^HTML.*Element$/.test(name))])
    Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? win : win[name] });
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  const test = await import(pathToFileURL(entry).href);
  try {
    if (process.argv.includes("--web-search")) await test.runWebSearchSettingsDomTests(win);
    else if (process.argv.includes("--polish")) await test.runSettingsPolishDomTests(win);
    else if (process.argv.includes("--plugin-rows")) await test.runBuiltinPluginRowDomTests(win);
    else await test.runSettingsSearchDomTests(win, () => new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true }));
  }
  finally { dom.window.close(); }
} finally {
  await rm(directory, { recursive: true, force: true });
}
