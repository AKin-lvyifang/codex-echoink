import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, ".tmp/resource-presentation-tests");
await mkdir(directory, { recursive: true });
try {
  const entry = path.join(directory, "test.mjs");
  await esbuild.build({
    entryPoints: ["src/tests/resource-presentation-dom.ts"], absWorkingDir: root,
    bundle: true, platform: "node", target: "node22", format: "esm", outfile: entry,
    banner: { js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);' },
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "yaml"],
    alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") }, logLevel: "silent"
  });
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://resource-fixture.invalid" });
  const win = dom.window;
  for (const name of ["window", "document", "navigator", "Element", "Node", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "SVGElement", "SVGSVGElement", "DOMParser", ...Object.getOwnPropertyNames(win).filter(name => /^HTML.*Element$/.test(name))]) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? win : win[name] });
  }
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  try {
    const { runResourcePresentationDomTests } = await import(pathToFileURL(entry).href);
    const snapshots = await runResourcePresentationDomTests(win);
    const snapshotDir = process.argv[process.argv.indexOf("--snapshots") + 1];
    if (process.argv.includes("--snapshots") && snapshotDir) {
      await mkdir(snapshotDir, { recursive: true });
      await writeFile(path.join(snapshotDir, "settings-snapshots.json"), JSON.stringify(snapshots));
    }
  } finally { dom.window.close(); }
} finally { await rm(directory, { recursive: true, force: true }); }
