import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { isDisposableTestRoot } from "./disposable-test-root.mjs";
import { desktopNodeTestAliases, desktopNodeTestBanner } from "./desktop-node-test-host.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const configured = process.env.ECHOINK_MEMORY_PAGE_TEST_ROOT?.trim() || process.env.ECHOINK_TEST_ROOT?.trim();
if (configured && (!path.isAbsolute(configured) || !isDisposableTestRoot(configured))) {
  throw new Error("Memory page tests require a disposable EchoInk test root");
}
const base = await realpath(configured || tmpdir());
if (configured && !isDisposableTestRoot(base)) throw new Error("Memory page test root cannot resolve outside the disposable Vault tree");
const directory = await mkdtemp(path.join(base, "echoink-memory-page-"));
try {
  const output = path.join(directory, "memory-page-tests.mjs");
  await esbuild.build({ stdin: { contents: `
    import { JSDOM } from "jsdom";
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://memory-page-fixture.invalid" });
    const win = dom.window;
    for (const name of ["window", "document", "navigator", "Element", "Node", "Document", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "SVGElement", ...Object.getOwnPropertyNames(win).filter(name => /^HTML.*Element$/.test(name))]) {
      Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? win : win[name] });
    }
    globalThis.getComputedStyle = win.getComputedStyle.bind(win);
    try {
      const { runMemoryPageTests } = await import("./src/tests/memory-page");
      await runMemoryPageTests(${JSON.stringify(directory)}, win);
    } finally { dom.window.close(); }
  `, resolveDir: root, loader: "ts", sourcefile: "memory-page-test-entry.ts" },
    bundle: true, platform: "node", target: "node22", format: "esm", outfile: output, sourcemap: "inline",
    banner: desktopNodeTestBanner, alias: desktopNodeTestAliases,
    loader: { ".md": "text", ".txt": "text", ".svg": "dataurl", ".webp": "dataurl" },
    plugins: [{ name: "memory-page-test-packages", setup(build) {
      build.onResolve({ filter: /^jsdom$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }));
    } }], logLevel: "silent"
  });
  const result = spawnSync(process.execPath, ["--enable-source-maps", output], { cwd: root, stdio: "inherit",
    env: { ...process.env, PI_OFFLINE: "1", ECHOINK_MEMORY_PAGE_TEST_ROOT: directory, TMPDIR: directory, TMP: directory, TEMP: directory } });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
